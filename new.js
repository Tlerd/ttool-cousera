// ==UserScript==
// @name         Coursera Auto Next Pro V3.1 (MutationObserver Engine)
// @namespace    http://tampermonkey.net/
// @version      3.1
// @description  Fix race condition: thêm grace period trước khi coi 1 trang là "bài đọc", tránh bỏ qua video tải chậm.
// @author       Đức Anh
// @match        https://www.coursera.org/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // Chống nạp script 2 lần (vài trường hợp Tampermonkey re-inject)
    if (window.__CANT_PRO_V3__) {
        console.warn('[Auto Next Pro V3] Script đã được nạp trước đó, bỏ qua.');
        return;
    }
    window.__CANT_PRO_V3__ = true;

    /* =========================================================================
     * 1. CONFIG + LOCAL STORAGE + STATE MANAGER
     * ========================================================================= */
    const STORAGE_KEY = 'cant_pro_v3_config';
    const DEFAULT_CONFIG = {
        targetSpeed: 2,
        readingSkipDelay: 5000, // ms
        nearEndThreshold: 2,    // giây - coi là "gần hết video"
        autoPlay: true,
        autoSpeed: true,
        autoNext: true,
        autoReading: true,
        panelVisible: true,
        running: true,
        superSpeed: false,
        panelTop: null,
        panelLeft: null,
    };

    function loadConfig() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return Object.assign({}, DEFAULT_CONFIG);
            return Object.assign({}, DEFAULT_CONFIG, JSON.parse(raw));
        } catch (e) {
            return Object.assign({}, DEFAULT_CONFIG);
        }
    }

    function saveConfig() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(CONFIG));
        } catch (e) { /* ignore (vd: storage bị chặn) */ }
    }

    const CONFIG = loadConfig();

    const READING_GRACE_MS = 1500;     // phải "không thấy video" liên tục bao lâu mới coi là bài đọc thật
    const FAST_NAV_WARN_MS = 1200;     // nếu 2 lần đổi URL cách nhau dưới mốc này -> log cảnh báo

    const STATE = {
        currentUrl: location.href,
        lastVideoSrc: null,
        lastDuration: null,
        readingTimer: null,
        noVideoSince: null,
        lastNavTime: 0,
        nextRetryTimer: null,
        nextRetryCount: 0,
        nextInFlight: false,
        itemsAdvanced: 0,
        autoPlayAttemptKey: null,
        autoPlayAttemptTime: null,
        playFailKey: null,
        playFailCount: 0,
        stalledAtPos: null,
        lastResumePos: null,
        resumeAttemptsAtPos: 0,
        lastFinishedVideoSrc: null,
        waitingForCompletion: false,
        completionFallbackTimer: null,
        wasMutedByTool: false,
        logs: [],
    };

    function resetStallState() {
        STATE.stalledAtPos = null;
        STATE.lastResumePos = null;
        STATE.resumeAttemptsAtPos = 0;
    }

    let videoEl = null;

    /* =========================================================================
     * 2. LOGGER (Console Log / Retry Log / Error Log)
     * ========================================================================= */
    function log(tag, msg) {
        const time = new Date().toLocaleTimeString();
        const line = '[' + time + '] [' + tag + '] ' + msg;
        const color = tag === 'ERROR' ? '#ff5555'
            : tag === 'RETRY' ? '#ffb86c'
                : tag === 'NEXT' || tag === 'PLAY' ? '#50fa7b'
                    : '#8be9fd';
        console.log('%c' + line, 'color:' + color);
        STATE.logs.unshift(line);
        if (STATE.logs.length > 30) STATE.logs.pop();
        renderLogPanel();
    }

    /* =========================================================================
     * 3. HISTORY API HOOK + URL OBSERVER (React SPA Detection)
     * ========================================================================= */
    function hookHistory(onChange) {
        const rawPush = history.pushState;
        const rawReplace = history.replaceState;
        history.pushState = function () {
            const ret = rawPush.apply(this, arguments);
            onChange();
            return ret;
        };
        history.replaceState = function () {
            const ret = rawReplace.apply(this, arguments);
            onChange();
            return ret;
        };
        window.addEventListener('popstate', onChange);
    }

    function handleUrlChange() {
        if (location.href === STATE.currentUrl) return;

        const now = Date.now();
        if (STATE.lastNavTime && (now - STATE.lastNavTime) < FAST_NAV_WARN_MS) {
            log('NAV', '⚠ 2 lần đổi URL cách nhau < ' + FAST_NAV_WARN_MS + 'ms -> nghi ngờ Coursera tự nhảy qua 1 mục trung gian, không phải do tool click 2 lần.');
        }
        STATE.lastNavTime = now;

        log('NAV', 'URL thay đổi -> coi như sang bài học mới.');
        if (STATE.nextInFlight) {
            STATE.itemsAdvanced++;
        }
        STATE.currentUrl = location.href;
        STATE.lastVideoSrc = null;
        STATE.lastDuration = null;
        STATE.noVideoSince = null;
        STATE.autoPlayAttemptKey = null;
        STATE.autoPlayAttemptTime = null;
        STATE.playFailCount = 0;
        STATE.waitingForCompletion = false;
        if (STATE.completionFallbackTimer) {
            clearTimeout(STATE.completionFallbackTimer);
            STATE.completionFallbackTimer = null;
        }
        STATE.wasMutedByTool = false;
        resetStallState();
        clearReadingTimer();
        clearNextRetry(true);
        videoEl = null; // buộc gắn lại observer/listener cho video ở trang mới
        setTimeout(scanPage, 300);
    }

    /* =========================================================================
     * 4. VIDEO OBSERVER + EVENT LISTENER
     * ========================================================================= */
    let videoAttrObserver = null;

    function attachVideoObserversIfNeeded() {
        const v = document.querySelector('video');
        if (!v) {
            videoEl = null;
            STATE.lastFinishedVideoSrc = null; // Reset khi không có video trong DOM (quá trình chuyển trang hoàn tất)
            return;
        }

        const src = v.currentSrc || v.src || ('dur:' + v.duration);
        if (STATE.lastFinishedVideoSrc && src === STATE.lastFinishedVideoSrc) {
            // Video cũ vẫn còn trong DOM trong quá trình chuyển trang, bỏ qua không xử lý
            videoEl = null;
            return;
        }

        // Phát hiện video mới (hoặc video thực sự khác), reset trạng thái video đã hoàn thành
        STATE.lastFinishedVideoSrc = null;

        if (v === videoEl) return;

        videoEl = v;
        log('VIDEO', 'Gắn event listener vào thẻ <video>.');

        v.addEventListener('loadedmetadata', onLoadedMetadata);
        v.addEventListener('playing', function () { enforceSpeed(v); });
        v.addEventListener('pause', onVideoPause);
        v.addEventListener('ratechange', function () { enforceSpeed(v); });
        v.addEventListener('timeupdate', function () {
            if (STATE.stalledAtPos !== null && Math.abs(v.currentTime - STATE.stalledAtPos) > 2) {
                log('INFO', 'Video đã chạy tiếp sau khi kẹt -> reset trạng thái stall.');
                resetStallState();
            }
            enforceSpeed(v); // Cập nhật tốc độ theo thời gian thực (để hạ tốc độ khi gần hết video)
        });
        v.addEventListener('ended', function () {
            log('END', "Sự kiện 'ended' kích hoạt -> chuẩn bị chuyển bài.");
            handleVideoCompletion();
        });

        // Theo dõi riêng thuộc tính src - một số bản Coursera tái dùng node <video>
        // cũ và chỉ đổi src thay vì tạo node mới (xem "Phát hiện 5" trong tài liệu).
        if (videoAttrObserver) videoAttrObserver.disconnect();
        videoAttrObserver = new MutationObserver(function () {
            onLoadedMetadata(); // dùng chung logic phát hiện "video mới"
        });
        videoAttrObserver.observe(v, { attributes: true, attributeFilter: ['src'] });

        // Nếu video đã có metadata sẵn (vd script load sau khi video đã load xong)
        if (v.readyState >= 1) onLoadedMetadata();
    }

    function onLoadedMetadata() {
        const v = videoEl;
        if (!v) return;
        const src = v.currentSrc || v.src || ('dur:' + v.duration);
        const isNew = src !== STATE.lastVideoSrc ||
            Math.abs((v.duration || 0) - (STATE.lastDuration || 0)) > 1;

        if (isNew) {
            log('VIDEO', 'Phát hiện video mới, duration=' + Math.round(v.duration || 0) + 's');
            STATE.lastVideoSrc = src;
            STATE.lastDuration = v.duration;
            STATE.autoPlayAttemptKey = null;
            STATE.autoPlayAttemptTime = null;
            STATE.playFailCount = 0;
            resetStallState();
            clearReadingTimer();
        }
        enforceSpeed(v);
        maybeAutoPlay(v);
    }

    function isNearEnd(v) {
        return v.duration > 0 && (v.duration - v.currentTime) < CONFIG.nearEndThreshold;
    }

    /* =========================================================================
     * 5. AUTO 2X + AUTO PLAY + AUTO RESUME + AUTO RETRY (video)
     * ========================================================================= */
    function enforceSpeed(v) {
        if (!CONFIG.running) return;

        let speed = CONFIG.targetSpeed;
        let shouldEnforce = CONFIG.autoSpeed;

        let isCurrentlySuperSpeed = CONFIG.superSpeed;
        let isInitialDelay = false;

        if (CONFIG.superSpeed && v.duration > 0) {
            const D = v.duration;
            if (v.currentTime < 5) {
                // Chạy 5 giây đầu ở tốc độ x1 để Coursera khởi tạo tiến trình
                isCurrentlySuperSpeed = false;
                isInitialDelay = true;
            } else if (D <= 180) {
                // Không áp dụng siêu tốc nếu video ngắn <= 3 phút (180s)
                isCurrentlySuperSpeed = false;
            } else {
                // Tính toán thời gian chạy x2 ở cuối (V2) sao cho tổng thời gian ở lại trang web (bao gồm 5s đầu và thời gian chạy 16x) bằng đúng 20% tổng thời lượng video.
                // Công thức: V2 = ((16 * R - 1) * D - 75) / 7 với R = 0.20
                const R = 0.20; // Tỷ lệ thời gian ở lại mục tiêu (20%)
                const V2 = ((16 * R - 1) * D - 75) / 7;
                const threshold = Math.max(0, Math.min(D - 5, V2));
                
                if ((D - v.currentTime) <= threshold) {
                    isCurrentlySuperSpeed = false;
                }
            }
        }

        if (isCurrentlySuperSpeed) {
            speed = 16;
            shouldEnforce = true;
        } else if (isInitialDelay) {
            speed = 1;
            shouldEnforce = true;
        }

        if (shouldEnforce && v.playbackRate !== speed) {
            v.playbackRate = speed;
        }

        // Chỉ tắt tiếng khi đang thực sự chạy ở chế độ siêu tốc (16x)
        if (isCurrentlySuperSpeed) {
            if (!v.muted) {
                v.muted = true;
                STATE.wasMutedByTool = true;
            }
        } else if (STATE.wasMutedByTool) {
            v.muted = false;
            STATE.wasMutedByTool = false;
        }
    }

    function handleVideoCompletion() {
        if (!CONFIG.autoNext || !CONFIG.running) return;
        if (STATE.waitingForCompletion) return;
        STATE.waitingForCompletion = true;
        log('END', 'Video đã kết thúc. Đang đợi Coursera ghi nhận hoàn thành (vòng tròn xanh lá)...');
        
        if (STATE.completionFallbackTimer) clearTimeout(STATE.completionFallbackTimer);
        STATE.completionFallbackTimer = setTimeout(function () {
            if (STATE.waitingForCompletion) {
                log('NEXT', 'Quá 6 giây chưa thấy vòng tròn xanh -> tự động chuyển tiếp (fallback).');
                goNext();
            }
        }, 6000);
    }

    function maybeAutoPlay(v) {
        if (!CONFIG.running || !CONFIG.autoPlay) return;
        if (!v.paused) { STATE.playFailCount = 0; return; }
        if (isNearEnd(v)) return; // gần cuối -> để onVideoPause/goNext xử lý, không play lại

        const key = v.currentSrc || v.src || 'unknown';
        if (STATE.autoPlayAttemptKey === key && STATE.autoPlayAttemptTime &&
            (Date.now() - STATE.autoPlayAttemptTime < 1500)) {
            return; // vừa thử play() cho video này, tránh gọi liên tục
        }
        STATE.autoPlayAttemptKey = key;
        STATE.autoPlayAttemptTime = Date.now();

        const p = v.play();
        if (p && typeof p.catch === 'function') {
            p.then(function () {
                STATE.playFailCount = 0;
                log('PLAY', 'Tự động play() thành công.');
            }).catch(function (err) {
                STATE.playFailCount = (STATE.playFailKey === key ? STATE.playFailCount + 1 : 1);
                STATE.playFailKey = key;
                log('RETRY', 'play() bị chặn (' + err.message + ') -> click nút Play UI. (lần ' + STATE.playFailCount + ')');
                clickPlayToggle();

                if (STATE.playFailCount >= 3) {
                    log('RETRY', 'Play thất bại nhiều lần -> thử video.load() rồi play lại.');
                    try { v.load(); } catch (e) { /* ignore */ }
                    STATE.playFailCount = 0;
                    setTimeout(function () { maybeAutoPlay(v); }, 1000);
                }
            });
        }
    }

    function clickPlayToggle() {
        const v = videoEl;
        if (!v || !v.paused) return;
        const btn = document.querySelector('[data-testid="playToggle"]') ||
            document.querySelector('.vjs-big-play-button') ||
            document.querySelector('button[aria-label="Play"]') ||
            document.querySelector('button[title="Play"]');
        if (btn) {
            btn.click();
            log('PLAY', 'Đã click nút Play trên UI.');
        } else {
            log('ERROR', 'Không tìm thấy nút Play nào (giao diện có thể đã đổi).');
        }
    }

    function onVideoPause() {
        const v = videoEl;
        if (!v) return;

        if (isNearEnd(v)) {
            log('END', 'Video dừng gần cuối -> chuẩn bị chuyển bài.');
            handleVideoCompletion();
            return;
        }

        if (!CONFIG.running || !CONFIG.autoPlay) return;

        const pos = Math.floor(v.currentTime);

        if (STATE.stalledAtPos === pos) return;

        if (STATE.lastResumePos === pos) {
            STATE.resumeAttemptsAtPos++;
        } else {
            STATE.lastResumePos = pos;
            STATE.resumeAttemptsAtPos = 1;
        }

        if (STATE.resumeAttemptsAtPos > 3) {
            STATE.stalledAtPos = pos;
            log('ERROR', '⛔ Video kẹt tại giây ' + pos + ' dù đã thử resume ' + STATE.resumeAttemptsAtPos +
                ' lần. Có thể đây là câu hỏi tương tác trong video hoặc cần thao tác tay. Tool đã NGỪNG tự resume video này.');
            return;
        }

        setTimeout(function () {
            if (videoEl === v && v.paused && !isNearEnd(v) && Math.floor(v.currentTime) === pos) {
                log('RETRY', 'Video bị dừng giữa chừng (giây ' + pos + ') -> thử resume (lần ' + STATE.resumeAttemptsAtPos + ').');
                maybeAutoPlay(v);
            }
        }, 800);
    }

    /* =========================================================================
     * 6. AUTO NEXT + RETRY ENGINE
     * ========================================================================= */
    function findNextButton() {
        return document.querySelector('button[aria-label="Go to next item"]') ||
            document.querySelector('[aria-label="Go to next item"]') ||
            Array.prototype.find.call(document.querySelectorAll('button'), function (b) {
                return b.offsetParent !== null &&
                    b.textContent.trim().toLowerCase() === 'go to next item';
            }) || null;
    }

    function findStartButton() {
        return document.querySelector('[data-testid="start-button"]') ||
            Array.prototype.find.call(document.querySelectorAll('button'), function (b) {
                return b.offsetParent !== null && b.textContent.trim().toLowerCase() === 'start';
            }) || null;
    }

    function goNext() {
        if (!CONFIG.autoNext || !CONFIG.running) return;
        STATE.waitingForCompletion = false;
        if (STATE.completionFallbackTimer) {
            clearTimeout(STATE.completionFallbackTimer);
            STATE.completionFallbackTimer = null;
        }
        if (videoEl) {
            STATE.lastFinishedVideoSrc = videoEl.currentSrc || videoEl.src || ('dur:' + videoEl.duration);
        }
        if (STATE.nextInFlight) return; // đã có 1 tiến trình chuyển bài đang chạy
        STATE.nextInFlight = true;
        STATE.nextRetryCount = 0;
        attemptNext();
    }

    function attemptNext() {
        const urlBefore = location.href;
        const nextBtn = findNextButton();
        const target = nextBtn || findStartButton();

        if (target && !target.disabled) {
            log('NEXT', 'Click nút: ' + (nextBtn ? 'Go to next item' : 'Start'));
            target.click();
            if (STATE.nextRetryTimer) clearTimeout(STATE.nextRetryTimer);
            STATE.nextRetryTimer = setTimeout(function () {
                if (location.href === urlBefore) {
                    retryNext(); // click rồi nhưng URL chưa đổi -> thử lại
                }
                // nếu URL đã đổi, handleUrlChange() sẽ tự reset nextInFlight
            }, 2500);
        } else {
            log('RETRY', 'Chưa thấy nút Next/Start hợp lệ trong DOM.');
            retryNext();
        }
    }

    function retryNext() {
        STATE.nextRetryCount++;
        if (STATE.nextRetryCount > 8) {
            log('ERROR', 'Đã thử 8 lần vẫn không chuyển được bài. Cần kiểm tra lại DOM (xem hướng dẫn debug ở dưới).');
            STATE.nextInFlight = false;
            return;
        }
        log('RETRY', 'Thử lại lần ' + STATE.nextRetryCount + '...');
        STATE.nextRetryTimer = setTimeout(attemptNext, 1000);
    }

    function clearNextRetry(resetInFlight) {
        if (STATE.nextRetryTimer) {
            clearTimeout(STATE.nextRetryTimer);
            STATE.nextRetryTimer = null;
        }
        if (resetInFlight) {
            STATE.nextInFlight = false;
            STATE.nextRetryCount = 0;
        }
    }

    /* =========================================================================
     * 6.5 COMPLETION CHECKER (Kiểm tra trạng thái hoàn thành)
     * ========================================================================= */
    function getActiveSidebarLink() {
        const path = location.pathname;
        const links = document.querySelectorAll('a');
        let bestMatch = null;
        for (const link of links) {
            const href = link.getAttribute('href');
            if (href) {
                const hrefUrl = href.split('?')[0].split('#')[0];
                const pathUrl = path.split('?')[0].split('#')[0];
                if (hrefUrl === pathUrl || hrefUrl.endsWith(pathUrl) || pathUrl.endsWith(hrefUrl)) {
                    // Ưu tiên liên kết nằm trong vùng điều hướng (sidebar/nav)
                    if (link.closest('nav') || link.closest('[role="navigation"]') ||
                        link.closest('[class*="navigation"]') || link.closest('[class*="sidebar"]') ||
                        link.closest('[class*="NavItem"]')) {
                        return link;
                    }
                    bestMatch = link;
                }
            }
        }
        return bestMatch;
    }

    function hasGreenColor(el) {
        const style = window.getComputedStyle(el);
        const checkColor = (colorStr) => {
            if (!colorStr) return false;
            const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (match) {
                const r = parseInt(match[1], 10);
                const g = parseInt(match[2], 10);
                const b = parseInt(match[3], 10);
                // Màu xanh lá chiếm ưu thế
                return (g > 100 && g > r + 20 && g > b + 20);
            }
            return false;
        };

        if (checkColor(style.color) || checkColor(style.fill) || checkColor(style.stroke)) {
            return true;
        }

        const fillAttr = el.getAttribute('fill');
        const strokeAttr = el.getAttribute('stroke');
        if (checkColor(fillAttr) || checkColor(strokeAttr)) {
            return true;
        }

        const isHexGreen = (hex) => {
            if (!hex || !hex.startsWith('#')) return false;
            const h = hex.substring(1);
            let r = 0, g = 0, b = 0;
            if (h.length === 3) {
                r = parseInt(h[0] + h[0], 16);
                g = parseInt(h[1] + h[1], 16);
                b = parseInt(h[2] + h[2], 16);
            } else if (h.length === 6) {
                r = parseInt(h.substring(0, 2), 16);
                g = parseInt(h.substring(2, 4), 16);
                b = parseInt(h.substring(4, 6), 16);
            } else {
                return false;
            }
            return (g > 100 && g > r + 20 && g > b + 20);
        };

        if (isHexGreen(fillAttr) || isHexGreen(strokeAttr) || isHexGreen(el.style.fill) || isHexGreen(el.style.stroke)) {
            return true;
        }

        return false;
    }

    function isCurrentItemCompleted() {
        const activeLink = getActiveSidebarLink();
        if (!activeLink) return false;

        // 1. Kiểm tra qua thuộc tính aria-label / title phổ biến
        const completedKeywords = ['completed', 'passed', 'success', 'checkmark', 'đã hoàn thành'];
        const elements = activeLink.querySelectorAll('*');
        for (const el of [activeLink, ...elements]) {
            const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
            if (completedKeywords.some(kw => label.includes(kw))) {
                return true;
            }
            const className = (el.className && typeof el.className === 'string' ? el.className : '').toLowerCase();
            if (className.includes('completed') || className.includes('checkmark')) {
                return true;
            }
        }

        // 2. Kiểm tra qua màu sắc (xanh lá cây) của các icon/svg bên trong link
        for (const el of elements) {
            if (['svg', 'path', 'circle', 'span', 'i'].includes(el.tagName.toLowerCase())) {
                if (hasGreenColor(el)) return true;
            }
        }

        return false;
    }

    function isNextButtonBlue(btn) {
        if (!btn) return false;
        const style = window.getComputedStyle(btn);
        const bg = style.backgroundColor;
        const color = style.color;
        const border = style.borderColor;
        
        function parseRgb(str) {
            if (!str) return null;
            const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            return m ? { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) } : null;
        }
        
        function isBlue(rgb) {
            if (!rgb) return false;
            // Màu xanh dương: b lớn, và b trội hơn r và g rõ rệt
            return rgb.b > 120 && rgb.b > rgb.r + 30 && rgb.b > rgb.g + 10;
        }
        
        const bgRgb = parseRgb(bg);
        const colRgb = parseRgb(color);
        const borderRgb = parseRgb(border);
        
        return isBlue(bgRgb) || isBlue(colRgb) || isBlue(borderRgb);
    }

    function isPageCompleted() {
        if (isCurrentItemCompleted()) return true;
        const nextBtn = findNextButton();
        if (nextBtn && isNextButtonBlue(nextBtn)) {
            log('INFO', 'Phát hiện nút "Go to next item" chuyển sang màu xanh dương -> bài học đã hoàn thành.');
            return true;
        }
        return false;
    }

    function scrollToBottom() {
        try {
            window.scrollTo({
                top: document.documentElement.scrollHeight || document.body.scrollHeight,
                behavior: 'smooth'
            });
        } catch (e) {
            window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight);
        }
    }

    /* =========================================================================
     * 7. AUTO READING (bài đọc / giới thiệu không có video)
     * ========================================================================= */
    function clearReadingTimer() {
        if (STATE.readingTimer) {
            clearTimeout(STATE.readingTimer);
            STATE.readingTimer = null;
        }
    }

    function maybeHandleReadingPage() {
        if (!CONFIG.autoReading || !CONFIG.running) return;
        if (STATE.readingTimer) return; // đang đếm rồi

        // Tự động cuộn xuống cuối trang để Coursera ghi nhận đã đọc
        scrollToBottom();

        // Chưa đủ lâu để chắc chắn "không có video" - video player có thể đang mount/tải.
        // Đây là điểm fix race condition: bản trước quyết định ngay ở lần quét đầu tiên
        // sau khi đổi URL, nên có lúc bắt trúng lúc video chưa kịp render -> bị coi nhầm
        // là bài đọc và bấm Next bỏ qua luôn video thật.
        if (!STATE.noVideoSince || (Date.now() - STATE.noVideoSince) < READING_GRACE_MS) {
            return;
        }

        const nextBtn = findNextButton();
        const startBtn = findStartButton();
        if (!nextBtn && !startBtn) return; // trang chưa tải xong phần điều hướng

        const seconds = Math.round(CONFIG.readingSkipDelay / 1000);
        log('READ', 'Không thấy video trong >' + (READING_GRACE_MS / 1000) + 's -> coi là bài đọc/giới thiệu. Đếm ' + seconds + 's...');
        STATE.readingTimer = setTimeout(function () {
            STATE.readingTimer = null;
            if (document.querySelector('video')) {
                log('READ', 'Phát hiện video xuất hiện trong lúc đếm -> hủy bỏ qua.');
                STATE.noVideoSince = null;
                return;
            }
            // Double-check lần 2 cách 400ms để chắc chắn tuyệt đối trước khi click
            setTimeout(function () {
                if (document.querySelector('video')) {
                    log('READ', 'Phát hiện video xuất hiện (double-check) -> hủy bỏ qua.');
                    STATE.noVideoSince = null;
                    return;
                }
                log('READ', 'Xác nhận là bài đọc thật -> chuyển bài.');
                goNext();
            }, 400);
        }, CONFIG.readingSkipDelay);
    }

    /* =========================================================================
     * 8. MASTER SCAN (chạy khi có thay đổi DOM, qua MutationObserver)
     * ========================================================================= */
    function scanPage() {
        attachVideoObserversIfNeeded(); // luôn cập nhật tham chiếu video, dù tool đang pause
        if (!CONFIG.running) { updatePanelInfo(); return; }

        // Nếu bài học hiện tại đã hoàn thành (hình tròn màu xanh hoặc nút Next màu xanh dương) -> bỏ qua và đi tiếp luôn
        if (isPageCompleted()) {
            log('INFO', 'Xác nhận trang hiện tại đã hoàn thành -> chuyển tiếp.');
            goNext();
            return;
        }

        const v = videoEl;
        if (v) {
            STATE.noVideoSince = null;
            clearReadingTimer();
            enforceSpeed(v);
            maybeAutoPlay(v);
            if (v.paused && isNearEnd(v)) handleVideoCompletion(); // lưới an toàn, song song với onVideoPause
        } else {
            if (STATE.noVideoSince === null) STATE.noVideoSince = Date.now();
            maybeHandleReadingPage();
        }
        updatePanelInfo();
    }

    let scanScheduled = false;
    function scheduleScan() {
        if (scanScheduled) return;
        scanScheduled = true;
        setTimeout(function () {
            scanScheduled = false;
            scanPage();
        }, 200);
    }

    /* =========================================================================
     * 9. DEBUG PANEL (giao diện nhỏ)
     * ========================================================================= */
    function injectStyles() {
        if (document.getElementById('cant-pro-style')) return;
        const style = document.createElement('style');
        style.id = 'cant-pro-style';
        style.textContent =
            '#cant-pro-panel{position:fixed;bottom:16px;right:16px;width:270px;' +
            'background:rgba(22,22,26,0.94);color:#f1f1f1;font-family:Consolas,Menlo,monospace;' +
            'font-size:12px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,0.4);' +
            'z-index:2147483647;overflow:hidden;}' +
            '#cant-pro-header{display:flex;justify-content:space-between;align-items:center;' +
            'padding:8px 10px;background:#282a36;cursor:default;font-weight:bold;}' +
            '#cant-pro-header button{background:none;border:none;color:#f1f1f1;cursor:pointer;font-size:14px;}' +
            '#cant-pro-body{padding:8px 10px;max-height:60vh;overflow-y:auto;}' +
            '.cant-pro-row{display:flex;justify-content:space-between;margin:3px 0;}' +
            '.cant-pro-row span:first-child{color:#9aa0aa;}' +
            '#cant-pro-panel label{display:flex;align-items:center;gap:6px;margin:4px 0;cursor:pointer;}' +
            '#cant-pro-panel hr{border:none;border-top:1px solid #3a3d46;margin:6px 0;}' +
            '#cant-pro-log{margin-top:6px;max-height:120px;overflow-y:auto;background:#11121a;' +
            'border-radius:6px;padding:4px 6px;}' +
            '.cant-pro-logline{font-size:10px;color:#8be9fd;white-space:nowrap;overflow:hidden;' +
            'text-overflow:ellipsis;}';
        document.head.appendChild(style);
    }

    function buildPanel() {
        if (document.getElementById('cant-pro-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'cant-pro-panel';
        if (CONFIG.panelTop && CONFIG.panelLeft) {
            panel.style.top = CONFIG.panelTop;
            panel.style.left = CONFIG.panelLeft;
            panel.style.bottom = 'auto';
            panel.style.right = 'auto';
        }
        panel.innerHTML =
            '<div id="cant-pro-header">' +
            '  <span>Auto Next Pro V3</span>' +
            '  <button id="cant-pro-toggle-visibility" title="Thu nhỏ / mở rộng">_</button>' +
            '</div>' +
            '<div id="cant-pro-body">' +
            '  <div class="cant-pro-row"><span>Trạng thái:</span><b id="cant-pro-status">-</b></div>' +
            '  <div class="cant-pro-row"><span>Tốc độ:</span><b id="cant-pro-speed">-</b></div>' +
            '  <div class="cant-pro-row"><span>Video:</span><span id="cant-pro-videoinfo">-</span></div>' +
            '  <div class="cant-pro-row"><span>Bài đã qua (session):</span><b id="cant-pro-count">0</b></div>' +
            '  <hr/>' +
            '  <label><input type="checkbox" id="cant-pro-cb-running"> Đang chạy (Pause/Resume)</label>' +
            '  <label><input type="checkbox" id="cant-pro-cb-play"> Auto Play</label>' +
            '  <label><input type="checkbox" id="cant-pro-cb-speed"> Auto 2x</label>' +
            '  <label><input type="checkbox" id="cant-pro-cb-superspeed"> Siêu tốc (16x + Mute)</label>' +
            '  <label><input type="checkbox" id="cant-pro-cb-next"> Auto Next</label>' +
            '  <label><input type="checkbox" id="cant-pro-cb-reading"> Auto Reading</label>' +
            '  <div class="cant-pro-row"><span>Reading delay (s):</span>' +
            '    <input type="number" id="cant-pro-delay" min="1" max="30" style="width:50px"></div>' +
            '  <hr/>' +
            '  <div id="cant-pro-log"></div>' +
            '</div>';
        document.body.appendChild(panel);
        wirePanelEvents();
        makeElementDraggable(panel, document.getElementById('cant-pro-header'));
    }

    function wirePanelEvents() {
        const cbRunning = document.getElementById('cant-pro-cb-running');
        const cbPlay = document.getElementById('cant-pro-cb-play');
        const cbSpeed = document.getElementById('cant-pro-cb-speed');
        const cbSuperSpeed = document.getElementById('cant-pro-cb-superspeed');
        const cbNext = document.getElementById('cant-pro-cb-next');
        const cbReading = document.getElementById('cant-pro-cb-reading');
        const inputDelay = document.getElementById('cant-pro-delay');
        const btnCollapse = document.getElementById('cant-pro-toggle-visibility');
        const body = document.getElementById('cant-pro-body');

        cbRunning.checked = CONFIG.running;
        cbPlay.checked = CONFIG.autoPlay;
        cbSpeed.checked = CONFIG.autoSpeed;
        cbSuperSpeed.checked = CONFIG.superSpeed || false;
        cbNext.checked = CONFIG.autoNext;
        cbReading.checked = CONFIG.autoReading;
        inputDelay.value = Math.round(CONFIG.readingSkipDelay / 1000);
        body.style.display = CONFIG.panelVisible ? 'block' : 'none';

        cbRunning.addEventListener('change', function () {
            CONFIG.running = cbRunning.checked;
            saveConfig();
            log('INFO', CONFIG.running ? 'Đã RESUME automation.' : 'Đã PAUSE automation.');
            if (CONFIG.running) scanPage();
            updatePanelInfo();
        });
        cbPlay.addEventListener('change', function () { CONFIG.autoPlay = cbPlay.checked; saveConfig(); });
        cbSpeed.addEventListener('change', function () { CONFIG.autoSpeed = cbSpeed.checked; saveConfig(); });
        cbSuperSpeed.addEventListener('change', function () {
            CONFIG.superSpeed = cbSuperSpeed.checked;
            saveConfig();
            if (videoEl) enforceSpeed(videoEl);
            updatePanelInfo();
        });
        cbNext.addEventListener('change', function () { CONFIG.autoNext = cbNext.checked; saveConfig(); });
        cbReading.addEventListener('change', function () { CONFIG.autoReading = cbReading.checked; saveConfig(); });
        inputDelay.addEventListener('change', function () {
            const sec = Math.max(1, Math.min(30, Number(inputDelay.value) || 5));
            CONFIG.readingSkipDelay = sec * 1000;
            inputDelay.value = sec;
            saveConfig();
        });
        btnCollapse.addEventListener('click', function () {
            CONFIG.panelVisible = !CONFIG.panelVisible;
            body.style.display = CONFIG.panelVisible ? 'block' : 'none';
            saveConfig();
        });
    }

    function makeElementDraggable(el, handle) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        
        handle.style.cursor = 'move';
        handle.addEventListener('mousedown', dragStart);
        handle.addEventListener('touchstart', dragStart, { passive: false });

        function dragStart(e) {
            e = e || window.event;
            const isTouch = e.type === 'touchstart';
            
            if (!isTouch && e.button !== 0) return; // Chỉ kéo chuột trái
            
            if (isTouch) {
                pos3 = e.touches[0].clientX;
                pos4 = e.touches[0].clientY;
            } else {
                e.preventDefault();
                pos3 = e.clientX;
                pos4 = e.clientY;
            }
            
            if (isTouch) {
                document.addEventListener('touchend', dragEnd);
                document.addEventListener('touchmove', dragMove, { passive: false });
            } else {
                document.addEventListener('mouseup', dragEnd);
                document.addEventListener('mousemove', dragMove);
            }
        }

        function dragMove(e) {
            e = e || window.event;
            const isTouch = e.type === 'touchmove';
            
            let clientX, clientY;
            if (isTouch) {
                clientX = e.touches[0].clientX;
                clientY = e.touches[0].clientY;
            } else {
                e.preventDefault();
                clientX = e.clientX;
                clientY = e.clientY;
            }
            
            pos1 = pos3 - clientX;
            pos2 = pos4 - clientY;
            pos3 = clientX;
            pos4 = clientY;
            
            const newTop = el.offsetTop - pos2;
            const newLeft = el.offsetLeft - pos1;
            
            el.style.top = newTop + "px";
            el.style.left = newLeft + "px";
            el.style.bottom = 'auto';
            el.style.right = 'auto';
        }

        function dragEnd(e) {
            const isTouch = e.type === 'touchend';
            if (isTouch) {
                document.removeEventListener('touchend', dragEnd);
                document.removeEventListener('touchmove', dragMove);
            } else {
                document.removeEventListener('mouseup', dragEnd);
                document.removeEventListener('mousemove', dragMove);
            }
            
            // Lưu vị trí
            CONFIG.panelTop = el.style.top;
            CONFIG.panelLeft = el.style.left;
            saveConfig();
        }
    }

    function updatePanelInfo() {
        const statusEl = document.getElementById('cant-pro-status');
        if (!statusEl) return; // panel chưa dựng xong
        statusEl.textContent = CONFIG.running ? 'Đang chạy' : 'Đã tạm dừng';
        statusEl.style.color = CONFIG.running ? '#50fa7b' : '#ffb86c';

        const speedEl = document.getElementById('cant-pro-speed');
        const videoInfoEl = document.getElementById('cant-pro-videoinfo');
        const countEl = document.getElementById('cant-pro-count');
        const v = videoEl;
        if (v) {
            speedEl.textContent = CONFIG.superSpeed ? '16.00x (Siêu tốc)' : v.playbackRate.toFixed(2) + 'x (mục tiêu ' + CONFIG.targetSpeed + 'x)';
            const t = Math.round(v.currentTime || 0), d = Math.round(v.duration || 0);
            videoInfoEl.textContent = t + 's/' + d + 's ' + (v.paused ? '(paused)' : '(playing)');
        } else {
            speedEl.textContent = '-';
            videoInfoEl.textContent = 'Không có video (bài đọc)';
        }
        countEl.textContent = String(STATE.itemsAdvanced);
    }

    function renderLogPanel() {
        const el = document.getElementById('cant-pro-log');
        if (!el) return;
        el.innerHTML = STATE.logs.slice(0, 8).map(function (l) {
            return '<div class="cant-pro-logline">' + escapeHtml(l) + '</div>';
        }).join('');
    }

    function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /* =========================================================================
     * 10. INIT
     * ========================================================================= */
    function init() {
        injectStyles();
        buildPanel();
        log('INFO', 'Coursera Auto Next Pro V3 đã khởi động.');

        hookHistory(handleUrlChange);
        window.addEventListener('popstate', handleUrlChange);

        // Lưới an toàn nhẹ - KHÔNG dùng để điều khiển chính, chỉ để bắt trường hợp
        // SPA điều hướng kiểu khác mà không gọi qua pushState/replaceState/popstate.
        setInterval(function () {
            if (location.href !== STATE.currentUrl) handleUrlChange();
        }, 1000);

        const observer = new MutationObserver(function () { scheduleScan(); });
        observer.observe(document.documentElement, { childList: true, subtree: true });

        setInterval(updatePanelInfo, 1000); // chỉ để cập nhật UI, không điều khiển logic

        scanPage();
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(init, 500);
    } else {
        window.addEventListener('DOMContentLoaded', function () { setTimeout(init, 500); });
    }

    // API debug thủ công từ Console: CANT_PRO.goNext(), CANT_PRO.scanPage(), v.v.
    window.CANT_PRO = {
        CONFIG: CONFIG,
        STATE: STATE,
        goNext: goNext,
        scanPage: scanPage,
        clickPlayToggle: clickPlayToggle,
        getVideo: function () { return videoEl; },
    };
})();
console.log("[OFP] content.js loaded at", document.readyState);

// ==================== CONFIGURATION ====================
const CONFIG = {
	MAX_CONCURRENT_FETCHES: 3,
	MAX_CACHE_SIZE: 300,
	RATE_LIMIT_DELAY: 333, // ms (3 requests per second)
	FETCH_TIMEOUT: 10000, // ms
	SONG_DETECTION_INTERVAL: 500, // ms
	
	// Timing constants for audio reload
	TIMING: {
		BUTTON_CLICK_DELAY: 100,
		RELOAD_SEQUENCE_DELAY: 800,
		PAUSE_AFTER_RELOAD: 800,
	},
	
	AUDIO_CACHE: new Map(),
};

const AUDIO_SERVERS = [
	"https://us.catboy.best",
	"https://sg.catboy.best",
	"https://catboy.best",
	"https://central.catboy.best",
];

const PREFIX = "osu!full preview :";

const ICONS = {
	IDLE: `<span class="fas fa-play-circle"></span>`,
	LOADING: `<span class="fas fa-circle-notch fa-spin"></span>`,
	READY: `<span class="fas fa-play-circle"></span>`,
};

const TOOLTIP = {
	ENABLE: "enable",
	PREPARING: "preparing",
	ENABLED: "enabled",
	FAILED: "failed",
};

const SELECTORS = {
	BEATMAP_PANEL: ".beatmapset-panel.js-audio--player",
	MENU_CONTAINER: ".beatmapset-panel__menu",
	TITLE_ELEMENT: ".beatmapset-panel__info-row--title",
	ARTIST_ELEMENT: ".beatmapset-panel__info-row--artist",
	PLAYING_PANEL: ".beatmapset-panel.js-audio--player[data-audio-state='playing']",
	AUDIO_PLAYER: ".audio-player",
	NEXT_BUTTON: ".audio-player__button--next.js-audio--nav",
	PREV_BUTTON: ".audio-player__button--prev.js-audio--nav",
	PLAY_BUTTON: ".js-audio--main-play",
};

// ==================== STATE MANAGEMENT ====================
const state = {
	beatmapCache: new Map(),
	pendingFetches: new Map(),
	activeFetches: 0,
	lastDetectedSong: null,
	observer: null,
	detectionInterval: null,
};

// ==================== RATE LIMITING ====================
const rateLimitQueue = [];
let processingQueue = false;

async function waitForRateLimit() {
	return new Promise((resolve) => {
		rateLimitQueue.push(resolve);
		if (!processingQueue) processQueue();
	});
}

function processQueue() {
	if (rateLimitQueue.length === 0) {
		processingQueue = false;
		return;
	}
	processingQueue = true;
	rateLimitQueue.shift()();
	setTimeout(processQueue, CONFIG.RATE_LIMIT_DELAY);
}

// ==================== UTILITIES ====================
const DEBUG = false; // Set to true for development, false for production

function log(message, level = 'info', ...args) {
	if (!DEBUG && level === 'info') return; // Only show warnings and errors in production
	
	const prefix = '[OFP]';
	const methods = {
		info: console.log,
		warn: console.warn,
		error: console.error,
	};
	(methods[level] || console.log)(prefix, message, ...args);
}

function manageCache(map, key, value) {
	if (map.has(key)) map.delete(key);
	map.set(key, value);
	if (map.size > CONFIG.MAX_CACHE_SIZE) {
		map.delete(map.keys().next().value);
	}
}

function extractSetIdFromUrl(url) {
	return url?.split("/").pop()?.replace(".mp3", "") ?? null;
}

function getOriginalAudioUrl(panel) {
	const link = panel.querySelector('a[href*="/beatmapsets/"]');
	if (!link) return null;

	const beatmapsetId = link.href.match(/\/beatmapsets\/(\d+)/)?.[1];
	if (!beatmapsetId) return null;

	return `https://b.ppy.sh/preview/${beatmapsetId}.mp3`;
}

function getPanelSongName(panel) {
	const titleElement = panel.querySelector(SELECTORS.TITLE_ELEMENT);
	const artistElement = panel.querySelector(SELECTORS.ARTIST_ELEMENT);

	if (!titleElement || !artistElement) return null;

	const artist = artistElement.textContent.replace("by ", "").trim();
	const title = titleElement.textContent.trim();
	return `${artist} - ${title}`;
}

// ==================== CACHE MANAGEMENT ====================
function cleanupBlobUrls() {
	for (const blobUrl of CONFIG.AUDIO_CACHE.values()) {
		URL.revokeObjectURL(blobUrl);
	}
	CONFIG.AUDIO_CACHE.clear();
}

// ==================== API COMMUNICATION ====================
async function fetchBeatmapId(setId) {
	if (state.beatmapCache.has(setId)) {
		return state.beatmapCache.get(setId);
	}

	if (state.pendingFetches.has(setId)) {
		return state.pendingFetches.get(setId);
	}

	const promise = new Promise((resolve) => {
		const attempt = () => {
			if (state.activeFetches < CONFIG.MAX_CONCURRENT_FETCHES) {
				state.activeFetches++;
				chrome.runtime.sendMessage(
					{ type: "FETCH_BEATMAP_ID", setId },
					(response) => {
						state.activeFetches--;
						state.pendingFetches.delete(setId);
						
						if (!response) {
							log(`No response for beatmap ID ${setId}`, 'error');
							resolve(null);
							return;
						}
						
						const { id } = response;
						if (id) {
							manageCache(state.beatmapCache, setId, id);
						}
						resolve(id ?? null);
					}
				);
			} else {
				setTimeout(attempt, 50);
			}
		};
		attempt();
	});

	state.pendingFetches.set(setId, promise);
	return promise;
}

async function downloadAndCacheAudio(beatmapId) {
	if (CONFIG.AUDIO_CACHE.has(beatmapId)) {
		return CONFIG.AUDIO_CACHE.get(beatmapId);
	}

	for (const server of AUDIO_SERVERS) {
		try {
			await waitForRateLimit();
			
			const res = await fetch(`${server}/preview/audio/${beatmapId}/full`, {
				signal: AbortSignal.timeout(CONFIG.FETCH_TIMEOUT),
			});
			
			if (!res.ok) continue;

			const blob = await res.blob();
			if (blob.size < 1000) continue;

			const url = URL.createObjectURL(blob);
			manageCache(CONFIG.AUDIO_CACHE, beatmapId, url);
			log(`Downloaded audio for beatmap ${beatmapId}`);
			return url;
		} catch (error) {
			log(`Download failed from ${server}: ${error.message}`, 'warn');
		}
	}
	
	log(`All servers failed for beatmap ${beatmapId}`, 'error');
	return null;
}

// ==================== UI ====================
function initializeStyles() {
	const style = document.createElement("style");
	style.textContent = `
		.beatmapset-panel__menu-item.ofp-ready {
			color: #ff94e8 !important;
		}
		.beatmapset-panel__menu-item.ofp-loading {
			opacity: 0.6;
		}
	`;
	(document.head || document.documentElement).appendChild(style);
}

function updateButtonState(button, icon, tooltip, className = "") {
	button.innerHTML = icon;
	button.setAttribute("data-orig-title", tooltip);
	button.setAttribute("title", `${PREFIX} ${tooltip}`);

	button.classList.remove("ofp-loading", "ofp-ready");
	if (className) {
		button.classList.add(className);
	}
}

function restoreDefaultPreview(button, panel) {
	if (!button.classList.contains("ofp-ready")) return;

	const originalUrl = getOriginalAudioUrl(panel);
	if (originalUrl) {
		panel.setAttribute("data-audio-url", originalUrl);
	}

	const blobUrl = panel.getAttribute("data-audio-url");
	if (panel.getAttribute("data-ofp-blob") === "true" && blobUrl) {
		URL.revokeObjectURL(blobUrl);
		panel.removeAttribute("data-ofp-blob");
	}

	updateButtonState(button, ICONS.IDLE, TOOLTIP.ENABLE);
}

// ==================== AUDIO CONTROL ====================
async function reloadAudio(paused) {
	return new Promise((resolve) => {
		const nextButton = document.querySelector(SELECTORS.NEXT_BUTTON);
		const playButton = document.querySelector(SELECTORS.PLAY_BUTTON);
		const prevButton = document.querySelector(SELECTORS.PREV_BUTTON);
		const player = document.querySelector(SELECTORS.AUDIO_PLAYER);

		if (!nextButton || !prevButton || !player) {
			log("Could not find navigation buttons", 'warn');
			resolve();
			return;
		}

		const hasNext = player.getAttribute("data-audio-has-next") === "1";
		const hasPrev = player.getAttribute("data-audio-has-prev") === "1";

		if (!hasPrev && !hasNext) {
			log("Next and prev unavailable", 'warn');
			resolve();
			return;
		}

		const { BUTTON_CLICK_DELAY, RELOAD_SEQUENCE_DELAY, PAUSE_AFTER_RELOAD } = CONFIG.TIMING;

		if (!hasNext) {
			// prev -> next
			prevButton.click();
			setTimeout(() => playButton.click(), BUTTON_CLICK_DELAY);
			setTimeout(() => {
				nextButton.click();
				resolve();
			}, RELOAD_SEQUENCE_DELAY);
		} else {
			// next -> prev
			nextButton.click();
			setTimeout(() => playButton.click(), BUTTON_CLICK_DELAY);
			setTimeout(() => {
				prevButton.click();
				resolve();
			}, RELOAD_SEQUENCE_DELAY);
		}

		if (paused) {
			setTimeout(() => playButton.click(), PAUSE_AFTER_RELOAD);
		}
	});
}

async function handleFullPreviewRequest(button, panel) {
	const buttonPanelSong = getPanelSongName(panel);
	const audioState = panel.getAttribute("data-audio-state");
	
	if (button.classList.contains("ofp-ready")) {
		restoreDefaultPreview(button, panel);
		console.log("last = ", state.lastDetectedSong)
		console.log("btnPnlSng = ", buttonPanelSong)
		console.log("");
		if (state.lastDetectedSong && state.lastDetectedSong === buttonPanelSong) {
			await reloadAudio(audioState === "paused");
		}
		return;
	}

	updateButtonState(button, ICONS.LOADING, TOOLTIP.PREPARING, "ofp-loading");

	const audioUrl = panel.getAttribute("data-audio-url");
	const setId = extractSetIdFromUrl(audioUrl);

	if (!setId) {
		log('Could not extract set ID from audio URL', 'error');
		updateButtonState(button, ICONS.IDLE, TOOLTIP.FAILED);
		return;
	}

	const beatmapId = await fetchBeatmapId(setId);
	if (!beatmapId) {
		updateButtonState(button, ICONS.IDLE, TOOLTIP.FAILED);
		return;
	}

	const blobUrl = await downloadAndCacheAudio(beatmapId);
	if (!blobUrl) {
		updateButtonState(button, ICONS.IDLE, TOOLTIP.FAILED);
		return;
	}

	panel.setAttribute("data-audio-url", blobUrl);
	panel.setAttribute("data-ofp-blob", "true");
	updateButtonState(button, ICONS.READY, TOOLTIP.ENABLED, "ofp-ready");

	// Reload audio if this is the currently playing/paused/loading song
	if (state.lastDetectedSong && state.lastDetectedSong !== buttonPanelSong) {
		return;
	}
	// Get the current audio state again after the async operations
	const currentAudioState = panel.getAttribute("data-audio-state");
	
	if (currentAudioState === "paused") {
		await reloadAudio(true);
	} else if (currentAudioState === "playing" || currentAudioState === "loading") {
		// Reload for both playing and loading states
		await reloadAudio(false);
	}
}

// ==================== MENU BUTTON ====================
function createMenuButton() {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "beatmapset-panel__menu-item ofp-menu-item";
	button.setAttribute("title", `${PREFIX} ${TOOLTIP.ENABLE}`);
	button.innerHTML = ICONS.IDLE;

	button.addEventListener("click", async (event) => {
		event.stopPropagation();
		event.preventDefault();

		const panel = event.target.closest(SELECTORS.BEATMAP_PANEL);
		if (panel) {
			await handleFullPreviewRequest(button, panel);
		}
	});

	return button;
}

function injectMenuButton(panel) {
	const menu = panel.querySelector(SELECTORS.MENU_CONTAINER);
	if (!menu || menu.querySelector(".ofp-menu-item")) return;

	const button = createMenuButton();
	menu.appendChild(button);
}

function attachMenuButtons() {
	document.querySelectorAll(SELECTORS.BEATMAP_PANEL).forEach(injectMenuButton);
}

// ==================== SONG DETECTION ====================
function detectPlayingSong() {
	const playingPanel = document.querySelector(SELECTORS.PLAYING_PANEL);

	if (!playingPanel) {
		if (state.lastDetectedSong !== null) {
			chrome.runtime.sendMessage({ type: "SONG_INFO", song: null });
		}
		return;
	}

	const currentSong = getPanelSongName(playingPanel);

	if (currentSong && currentSong !== state.lastDetectedSong) {
		state.lastDetectedSong = currentSong;
		chrome.runtime.sendMessage({ type: "SONG_INFO", song: currentSong });
	}
}

// ==================== CLEANUP ====================
function cleanup() {
	cleanupBlobUrls();
	rateLimitQueue.length = 0;
	
	if (state.observer) {
		state.observer.disconnect();
		state.observer = null;
	}
	
	if (state.detectionInterval) {
		clearInterval(state.detectionInterval);
		state.detectionInterval = null;
	}
}

// ==================== INITIALIZATION ====================
function initialize() {
	log('Extension initialized');
	
	window.addEventListener("beforeunload", cleanup);

	initializeStyles();
	attachMenuButtons();

	state.observer = new MutationObserver(attachMenuButtons);
	state.observer.observe(document.documentElement, {
		childList: true,
		subtree: true,
	});

	state.detectionInterval = setInterval(() => {
		if (!document.hidden) {
			detectPlayingSong();
		}
	}, CONFIG.SONG_DETECTION_INTERVAL);

	detectPlayingSong();
}

initialize();

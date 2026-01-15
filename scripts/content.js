console.log("[OFP] content.js loaded at", document.readyState);

const CONFIG = {
	MAX_CONCURRENT_FETCHES: 3,
	MAX_CACHE_SIZE: 300,
	AUDIO_CACHE: new Map(),
};

const AUDIO_SERVERS = [
	'https://us.catboy.best',
	'https://sg.catboy.best',
	'https://catboy.best',
	'https://central.catboy.best'
];

const rateLimitQueue = [];
let processingQueue = false;

async function waitForRateLimit() {
	return new Promise((resolve) => {
		rateLimitQueue.push(resolve);
		if (!processingQueue) processQueue();
	});
}

function processQueue() {
	processingQueue = true;
	try {
		if (rateLimitQueue.length === 0) {
			processingQueue = false;
			return;
		}

		const resolve = rateLimitQueue.shift();
		resolve();
		// Limit to 3 requests per second
		setTimeout(processQueue, 1000 / 3);
	} catch (error) {
		console.error("[OFP] Rate limiter error:", error);
		processingQueue = false;
		// Reset after error
		setTimeout(processQueue, 1000);
	}
}

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

const state = {
	beatmapCache: new Map(), // setId -> beatmapId
	pendingFetches: new Map(), // setId -> Promise
	activeFetches: 0,
	lastDetectedSong: null,
};

// DOM Selectors
const SELECTORS = {
	BEATMAP_PANEL: ".beatmapset-panel.js-audio--player",
	MENU_CONTAINER: ".beatmapset-panel__menu",
	TITLE_ELEMENT: ".beatmapset-panel__info-row--title",
	ARTIST_ELEMENT: ".beatmapset-panel__info-row--artist",
	PLAYING_PANEL:
		".beatmapset-panel.js-audio--player[data-audio-state='playing']",
	AUDIO_PLAYER: ".audio-player",
	NEXT_BUTTON: ".audio-player__button--next.js-audio--nav",
	PREV_BUTTON: ".audio-player__button--prev.js-audio--nav",
	PLAY_BUTTON: ".js-audio--main-play",
};

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

function manageCacheSize() {
	if (state.beatmapCache.size > CONFIG.MAX_CACHE_SIZE) {
		state.beatmapCache.clear();
	}
}

async function fetchWithConcurrency(setId) {
	return new Promise((resolve) => {
		const attemptFetch = () => {
			if (state.activeFetches < CONFIG.MAX_CONCURRENT_FETCHES) {
				state.activeFetches++;

				chrome.runtime.sendMessage(
					{ type: "FETCH_BEATMAP_ID", setId },
					(response) => {
						state.activeFetches--;

						const beatmapId = response?.id ?? null;
						if (beatmapId) {
							state.beatmapCache.set(setId, beatmapId);
							manageCacheSize();
						}

						state.pendingFetches.delete(setId);
						resolve(beatmapId);
					}
				);
			} else {
				setTimeout(attemptFetch, 50);
			}
		};

		attemptFetch();
	});
}

async function fetchBeatmapId(setId) {
	if (state.beatmapCache.has(setId)) {
		return Promise.resolve(state.beatmapCache.get(setId));
	}

	if (state.pendingFetches.has(setId)) {
		return state.pendingFetches.get(setId);
	}

	const fetchPromise = fetchWithConcurrency(setId);
	state.pendingFetches.set(setId, fetchPromise);

	return fetchPromise;
}

function extractSetIdFromUrl(audioUrl) {
	if (!audioUrl) return null;

	const parts = audioUrl.split("/");
	const filename = parts.pop();
	const setId = filename?.replace(".mp3", "");

	return setId || null;
}

function getOriginalAudioUrl(panel) {
	const titleElement = panel.querySelector(SELECTORS.TITLE_ELEMENT);
	if (!titleElement) return null;

	const link = panel.querySelector('a[href*="/beatmapsets/"]');
	if (!link) return null;

	const beatmapsetId = link.href.match(/\/beatmapsets\/(\d+)/)?.[1];
	if (!beatmapsetId) return null;

	return `https://b.ppy.sh/preview/${beatmapsetId}.mp3`;
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

// reload audio with updated source by quickly playing a different audio and switching back which triggers the load() in internal osu audio/main.ts code
async function reloadAudio(paused) {
	return new Promise((resolve) => {
		const nextButton = document.querySelector(SELECTORS.NEXT_BUTTON);
		const playButton = document.querySelector(SELECTORS.PLAY_BUTTON);
		const prevButton = document.querySelector(SELECTORS.PREV_BUTTON);
		const player = document.querySelector(SELECTORS.AUDIO_PLAYER);

		if (!nextButton || !prevButton || !player) {
			console.log("[OFP] Could not find next/prev buttons");
			resolve();
			return;
		}

		const hasNext = player.getAttribute("data-audio-has-next") === "1";
		const hasPrev = player.getAttribute("data-audio-has-prev") === "1";

		if (!hasPrev && !hasNext) {
			console.log("[OFP] next and prev unavailable");
			resolve();
			return;
		}

		if (!hasNext) {
			console.log("[OFP] Last panel → using prev → next");

			prevButton.click();
			setTimeout(() => {
				playButton.click();
			}, 100);

			setTimeout(() => {
				nextButton.click();
				resolve();
			}, 800);
		} else {
			console.log("[OFP] Normal panel → using next → prev");

			nextButton.click();
			setTimeout(() => {
				playButton.click();
			}, 100);

			setTimeout(() => {
				prevButton.click();
				resolve();
			}, 800);
		}

		if (paused) {
			setTimeout(() => {
				playButton.click();
			}, 800);
		}
	});
}

function restoreDefaultPreview(button, panel) {
	if (!button.classList.contains("ofp-ready")) return;

	const originalUrl = getOriginalAudioUrl(panel);
	if (originalUrl) {
		panel.setAttribute("data-audio-url", originalUrl);
	}

	const blobUrl = panel.getAttribute("data-audio-url");
	// Check if we need to revoke blob URL
	if (panel.getAttribute("data-ofp-blob") === "true" && blobUrl) {
		URL.revokeObjectURL(blobUrl);
		panel.removeAttribute("data-ofp-blob");
	}

	updateButtonState(button, ICONS.IDLE, TOOLTIP.ENABLE);
}

function cleanupBlobUrls() {
	for (const blobUrl of CONFIG.AUDIO_CACHE.values()) {
		URL.revokeObjectURL(blobUrl);
	}
	CONFIG.AUDIO_CACHE.clear();
}

window.addEventListener("beforeunload", cleanupBlobUrls);

async function handleFullPreviewRequest(button, panel) {
	const state = panel.getAttribute("data-audio-state");

	if (button.classList.contains("ofp-ready")) {
		restoreDefaultPreview(button, panel);

		if (state !== "loading") {
			await reloadAudio(state === "paused");
		}
		return;
	}

	updateButtonState(button, ICONS.LOADING, TOOLTIP.PREPARING, "ofp-loading");

	const audioUrl = panel.getAttribute("data-audio-url");
	const setId = extractSetIdFromUrl(audioUrl);

	if (!setId) {
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

	if (state === "paused") {
		await reloadAudio(true);
	}

	updateButtonState(button, ICONS.READY, TOOLTIP.ENABLED, "ofp-ready");

	if (state === "playing") {
		await reloadAudio();
	}
}

function createMenuButton() {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "beatmapset-panel__menu-item ofp-menu-item";
	button.setAttribute("title", `${PREFIX} ${TOOLTIP.ENABLE}`);
	button.innerHTML = ICONS.IDLE;

	button.addEventListener("click", async (event) => {
		event.stopPropagation();
		event.preventDefault();

		const panel = button.closest(SELECTORS.BEATMAP_PANEL);
		if (panel) {
			await handleFullPreviewRequest(button, panel);
		}
	});

	return button;
}

function injectMenuButton(panel) {
	const menu = panel.querySelector(SELECTORS.MENU_CONTAINER);
	if (!menu) return;

	if (menu.querySelector(".ofp-menu-item")) return;

	const button = createMenuButton();
	menu.appendChild(button);
}

function attachMenuButtons() {
	document.querySelectorAll(SELECTORS.BEATMAP_PANEL).forEach(injectMenuButton);
}

async function downloadAndCacheAudio(beatmapId) {
	if (CONFIG.AUDIO_CACHE.has(beatmapId)) {
		return CONFIG.AUDIO_CACHE.get(beatmapId);
	}

	let lastError = null;
	
	for (const serverUrl of AUDIO_SERVERS) {
		try {
			await waitForRateLimit();

			const audioUrl = `${serverUrl}/preview/audio/${beatmapId}/full`;
			console.log(`[OFP] Trying audio from: ${audioUrl}`);
			
			const response = await fetch(audioUrl, {
				signal: AbortSignal.timeout(10000)
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status} from ${serverUrl}`);
			}

			const audioBlob = await response.blob();
			
			if (audioBlob.size < 1000) {
				throw new Error(`Audio too small (${audioBlob.size} bytes) from ${serverUrl}`);
			}
			
			if (!audioBlob.type.startsWith('audio/') && audioBlob.type !== 'application/octet-stream') {
				console.warn(`[OFP] Unexpected content type: ${audioBlob.type} from ${serverUrl}`);
			}

			const blobUrl = URL.createObjectURL(audioBlob);

			CONFIG.AUDIO_CACHE.set(beatmapId, blobUrl);
			console.log(`[OFP] Audio cached successfully from ${serverUrl}`);

			return blobUrl;
			
		} catch (error) {
			console.error(`[OFP] Failed to download audio from ${serverUrl}:`, error.message);
			lastError = error;
			continue;
		}
	}
	
	console.error("[OFP] All audio servers failed:", lastError?.message);
	return null;
}

function detectPlayingSong() {
	const playingPanel = document.querySelector(SELECTORS.PLAYING_PANEL);

	if (!playingPanel) {
		if (state.lastDetectedSong !== null) {
			state.lastDetectedSong = null;
			chrome.runtime.sendMessage({ type: "SONG_INFO", song: null });
		}
		return;
	}

	const titleElement = playingPanel.querySelector(SELECTORS.TITLE_ELEMENT);
	const artistElement = playingPanel.querySelector(SELECTORS.ARTIST_ELEMENT);

	if (!titleElement || !artistElement) return;

	const artist = artistElement.textContent.replace("by ", "").trim();
	const title = titleElement.textContent.trim();
	const currentSong = `${artist} - ${title}`;

	if (currentSong !== state.lastDetectedSong) {
		state.lastDetectedSong = currentSong;
		chrome.runtime.sendMessage({ type: "SONG_INFO", song: currentSong });
	}
}

function initialize() {
	window.addEventListener("beforeunload", () => {
		cleanupBlobUrls();
		rateLimitQueue.length = 0; // Clear any pending rate limit requests
	});

	initializeStyles();
	attachMenuButtons();

	const observer = new MutationObserver(attachMenuButtons);
	observer.observe(document.documentElement, {
		childList: true,
		subtree: true,
	});

	setInterval(detectPlayingSong, 500);
	detectPlayingSong();
}

initialize();

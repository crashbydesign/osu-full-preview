let currentSong = null;

const SERVER_URLS = [
	"https://catboy.best",
	"https://central.catboy.best",
	"https://us.catboy.best",
	"https://sg.catboy.best",
];

const STORAGE_KEY = "serverPenalties";

/* -------------------- storage helpers -------------------- */

async function loadPenalties() {
	const data = await chrome.storage.local.get(STORAGE_KEY);
	return data[STORAGE_KEY] ?? {};
}

async function savePenalties(penalties) {
	await chrome.storage.local.set({ [STORAGE_KEY]: penalties });
}

async function updateApiPenalty(url, delta) {
	const penalties = await loadPenalties();

	penalties[url] ??= { api: 0, audio: 0 };
	penalties[url].api = Math.min(50, Math.max(0, penalties[url].api + delta));

	await savePenalties(penalties);
}

/* -------------------- priority logic -------------------- */

async function getApiServersByPriority() {
	const penalties = await loadPenalties();

	return SERVER_URLS.map((url) => ({
		url,
		penalty: penalties[url]?.api ?? 0,
	})).sort((a, b) => a.penalty - b.penalty);
}

/* -------------------- API fetch -------------------- */

async function fetchBeatmapId(setId, serverUrl) {
	try {
		console.log(`[OFP BG] Fetching beatmapId from ${serverUrl}`);
		const res = await fetch(`${serverUrl}/api/v2/s/${setId}`, {
			signal: AbortSignal.timeout(5000),
		});

		if (!res.ok) throw new Error(`HTTP ${res.status}`);

		const data = await res.json();
		return data?.beatmaps?.[0]?.id ?? null;
	} catch (err) {
		console.log(`[OFP BG] Failed from ${serverUrl}:`, err.message);
		return null;
	}
}

async function fetchBeatmapIdWithFallback(setId) {
	const servers = await getApiServersByPriority();

	for (const server of servers) {
		const id = await fetchBeatmapId(setId, server.url);

		if (id !== null) {
			await updateApiPenalty(server.url, -1); // success
			return id;
		}

		await updateApiPenalty(server.url, +2); // failure
	}

	console.log("[OFP BG] All API servers failed");
	return null;
}

/* -------------------- messaging -------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	switch (msg.type) {
		case "SONG_INFO":
			currentSong = msg.song;
			break;

		case "GET_SONG":
			sendResponse({ song: currentSong });
			break;

		case "FETCH_BEATMAP_ID":
			fetchBeatmapIdWithFallback(msg.setId).then((id) => {
				sendResponse({ id });
			});
			return true;
	}
});

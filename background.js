let currentSong = null;

// Define servers with priority order
const SERVERS = [
	"https://catboy.best",
	"https://central.catboy.best",
	"https://us.catboy.best",
	"https://sg.catboy.best",
];

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
			return true; // Keep port open for async response
	}
});

async function fetchBeatmapId(setId, serverUrl) {
	try {
		console.log(`[OFP] Trying server: ${serverUrl}`);
		const response = await fetch(`${serverUrl}/api/v2/s/${setId}`, {
			signal: AbortSignal.timeout(5000), // 5 second timeout
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		const data = await response.json();
		return data?.beatmaps?.[0]?.id ?? null;
	} catch (error) {
		console.log(`[OFP] Server ${serverUrl} failed:`, error.message);
		return null;
	}
}

async function fetchBeatmapIdWithFallback(setId) {
	for (const serverUrl of SERVERS) {
		const result = await fetchBeatmapId(setId, serverUrl);
		if (result !== null) {
			console.log(`[OFP] Successfully fetched from ${serverUrl}`);
			return result;
		}
	}

	console.log("[OFP] All servers failed");
	return null;
}

const songEl = document.getElementById('song');
const refreshBtn = document.getElementById('refresh');

function updateSong() {
  chrome.runtime.sendMessage({ type: 'GET_SONG' }, (response) => {
    const song = response?.song || 'No song detected';
    songEl.textContent = song;
    
    if (song !== 'No song detected') {
      songEl.classList.add('playing');
    } else {
      songEl.classList.remove('playing');
    }
  });
}

refreshBtn.addEventListener('click', updateSong);
updateSong();

setInterval(updateSong, 3000);
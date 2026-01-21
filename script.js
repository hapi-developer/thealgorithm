const settings = {
  sound: true,
  reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  highContrast: false,
};

function loadSettings() {
  const stored = JSON.parse(localStorage.getItem("qqd-settings") || "{}");
  return { ...settings, ...stored };
}

function saveSettings(next) {
  localStorage.setItem("qqd-settings", JSON.stringify(next));
}

function applyContrast(value) {
  document.body.classList.toggle("high-contrast", value);
}

const current = loadSettings();
applyContrast(current.highContrast);

const soundToggle = document.getElementById("soundToggle");
const motionToggle = document.getElementById("motionToggle");
const contrastToggle = document.getElementById("contrastToggle");

soundToggle.checked = current.sound;
motionToggle.checked = current.reducedMotion;
contrastToggle.checked = current.highContrast;

soundToggle.addEventListener("change", (event) => {
  current.sound = event.target.checked;
  saveSettings(current);
});

motionToggle.addEventListener("change", (event) => {
  current.reducedMotion = event.target.checked;
  saveSettings(current);
});

contrastToggle.addEventListener("change", (event) => {
  current.highContrast = event.target.checked;
  applyContrast(current.highContrast);
  saveSettings(current);
});

function goTo(mode) {
  saveSettings(current);
  window.location.href = `game.html?mode=${mode}`;
}

document.getElementById("playChallenge").addEventListener("click", () => goTo("challenge"));
document.getElementById("playZen").addEventListener("click", () => goTo("zen"));

const toast = document.querySelector(".toast");
const header = document.querySelector("[data-header]");

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.hidden = true;
  }, 2400);
}

function syncHeader() {
  header.classList.toggle("is-scrolled", window.scrollY > 24);
}

document.querySelectorAll("[data-download]").forEach((link) => {
  link.addEventListener("click", () => showToast("正在从 GitHub Releases 下载 Windows 安装包"));
});

window.addEventListener("scroll", syncHeader, { passive: true });
syncHeader();

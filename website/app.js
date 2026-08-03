const toast = document.querySelector(".toast");

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { toast.hidden = true; }, 2200);
}

document.querySelectorAll("[data-download]").forEach((link) => {
  link.addEventListener("click", () => showToast("正在从 GitHub Releases 下载"));
});

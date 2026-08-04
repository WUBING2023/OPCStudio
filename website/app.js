const toast = document.querySelector(".toast");
const header = document.querySelector("[data-header]");
const community = window.OPC_COMMUNITY || {
  repo: "WUBING2023/OPCStudio",
  generated: null,
  stars: 0,
  located: 0,
  countries: [],
  points: [],
};

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

function formatCount(value) {
  return new Intl.NumberFormat("en-US").format(Number(value) || 0);
}

function setText(selector, value) {
  document.querySelectorAll(selector).forEach((node) => {
    node.textContent = value;
  });
}

function syncCommunityStats(stars = community.stars) {
  setText("[data-star-count]", formatCount(stars));
  setText("[data-located-count]", formatCount(community.located));
  setText("[data-country-count]", formatCount(community.countries.length));
  setText(
    "[data-community-updated]",
    community.generated
      ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(community.generated))
      : "待首次聚合",
  );
}

async function refreshStarCount() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`https://api.github.com/repos/${community.repo}`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!response.ok) return;
    const metadata = await response.json();
    syncCommunityStats(metadata.stargazers_count);
  } catch {
    // The generated snapshot remains visible when GitHub is unavailable.
  } finally {
    window.clearTimeout(timeout);
  }
}

function renderCommunityMap() {
  const mapNode = document.querySelector("#community-map");
  const emptyNode = document.querySelector("[data-map-empty]");
  const points = Array.isArray(community.points) ? community.points : [];

  emptyNode.hidden = points.length > 0;
  if (!mapNode || !window.echarts || !window.WORLD_GEO) return;

  window.echarts.registerMap("opc-world", window.WORLD_GEO);
  const chart = window.echarts.init(mapNode, null, { renderer: "canvas" });
  const maxCount = Math.max(1, ...points.map((point) => Number(point.count) || 0));
  chart.setOption({
    animationDuration: 650,
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      borderWidth: 0,
      backgroundColor: "#f7f8f4",
      textStyle: { color: "#171817", fontSize: 12 },
      formatter: ({ data }) => data ? `${data.name}<br><strong>${formatCount(data.count)} Stargazer${data.count === 1 ? "" : "s"}</strong>` : "",
    },
    geo: {
      map: "opc-world",
      roam: true,
      zoom: 1.12,
      scaleLimit: { min: 1, max: 6 },
      itemStyle: { areaColor: "#262a26", borderColor: "#5d635c", borderWidth: 0.6 },
      emphasis: { disabled: true },
      select: { disabled: true },
      silent: points.length === 0,
    },
    series: [{
      type: "effectScatter",
      coordinateSystem: "geo",
      data: points.map((point) => ({
        name: point.name,
        count: Number(point.count) || 0,
        value: [Number(point.lng), Number(point.lat), Number(point.count) || 0],
      })),
      symbolSize: (value) => 8 + Math.sqrt(value[2] / maxCount) * 18,
      showEffectOn: "render",
      rippleEffect: { scale: 2.4, brushType: "stroke" },
      itemStyle: { color: "#a8f238", borderColor: "#ffffff", borderWidth: 1 },
      emphasis: { scale: 1.15 },
      zlevel: 2,
    }],
  });

  const resize = () => chart.resize();
  window.addEventListener("resize", resize, { passive: true });
}

document.querySelectorAll("[data-download]").forEach((link) => {
  link.addEventListener("click", () => showToast("正在从 GitHub Releases 下载 Windows 安装包"));
});

window.addEventListener("scroll", syncHeader, { passive: true });
syncHeader();
syncCommunityStats();
renderCommunityMap();
refreshStarCount();
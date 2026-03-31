import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Camera,
  Download,
  History,
  Loader2,
  Moon,
  Pencil,
  Sun,
  Check,
  X,
  Trash2,
} from "lucide-react";
import "./index.css";
import {
  createPreviewKey,
  createZipKey,
  loadHistory,
  loadPreviewBlob,
  loadZipBlob,
  removeStoredBlob,
  saveHistory,
  storePreviewBlob,
} from "./historyStore";

const MAX_HISTORY = 20;
const DEVICE_PRESETS = [
  { id: "desktop", label: "Desktop", width: 1920, height: 1080 },
  { id: "mobile", label: "Mobile", width: 390, height: 844 },
  { id: "tablet", label: "Tablet", width: 768, height: 1024 },
  { id: "iphone_15_pro", label: "iPhone 15 Pro", width: 393, height: 852 },
  { id: "ipad", label: "iPad", width: 820, height: 1180 },
  { id: "desktop_hd", label: "Desktop HD", width: 1366, height: 768 },
  { id: "desktop_4k", label: "Desktop 4K", width: 3840, height: 2160 },
];

function App() {
  const [theme, setTheme] = useState("dark");
  const [view, setView] = useState("capture");
  const [url, setUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState(
    "Enter a site URL or sitemap URL to generate full-page PDF exports.",
  );
  const [status, setStatus] = useState({
    stage: "idle",
    message: "",
    completed: 0,
    total: 0,
    currentUrl: "",
  });
  const [logs, setLogs] = useState([]);
  const eventSourceRef = useRef(null);
  const [downloadReady, setDownloadReady] = useState(false);
  const [downloadJob, setDownloadJob] = useState({
    jobId: null,
    name: null,
    blobKey: null,
  });
  const [isDownloading, setIsDownloading] = useState(false);
  const [previews, setPreviews] = useState([]);
  const [previewError, setPreviewError] = useState("");
  const [selectedPreview, setSelectedPreview] = useState(null);
  const [visiblePreviewCount, setVisiblePreviewCount] = useState(6);
  const [historyEntries, setHistoryEntries] = useState([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState(null);
  const [historyDetailId, setHistoryDetailId] = useState(null);
  const [historyPreviewUrls, setHistoryPreviewUrls] = useState({});
  const [historyPreviewCount, setHistoryPreviewCount] = useState(8);
  const [isSavingHistory, setIsSavingHistory] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [editEntryId, setEditEntryId] = useState(null);
  const [editEntryValue, setEditEntryValue] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState([
    "desktop",
    "mobile",
  ]);
  const [hideSticky, setHideSticky] = useState(false);
  const [customSizeInput, setCustomSizeInput] = useState("");
  const [customSizes, setCustomSizes] = useState([]);
  const [displayPercent, setDisplayPercent] = useState(0);
  const previewUrlsRef = useRef([]);
  const progressRafRef = useRef(null);
  const displayPercentRef = useRef(0);
  const targetPercentRef = useRef(0);
  const [detachSelectorsInput, setDetachSelectorsInput] = useState("");
  const [detachSelectors, setDetachSelectors] = useState([]);
  const [previewItems, setPreviewItems] = useState([]);
  const [previewIndex, setPreviewIndex] = useState(0);

  const progressPercent = useMemo(() => {
    if (!status.total) return 0;
    return Math.min(100, Math.round((status.completed / status.total) * 100));
  }, [status.completed, status.total]);

  const selectedHistory = useMemo(() => {
    return historyEntries.find((entry) => entry.id === selectedHistoryId) || null;
  }, [historyEntries, selectedHistoryId]);

  const historyDetail = useMemo(() => {
    return historyEntries.find((entry) => entry.id === historyDetailId) || null;
  }, [historyEntries, historyDetailId]);

  const historyPreviewItems = useMemo(() => {
    if (!historyDetail) return [];
    return historyDetail.items.map((item) => {
      const devices = (item.devices || []).map((device) => ({
        id: device.id,
        label: device.label,
        url: historyPreviewUrls[device.key],
      }));
      return {
        id: item.id,
        title: item.title,
        pageUrl: item.pageUrl,
        devices,
      };
    });
  }, [historyDetail, historyPreviewUrls]);

  useEffect(() => {
    const stored = window.localStorage.getItem("theme");
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")
      .matches;
    const initial = stored || (prefersDark ? "dark" : "light");
    setTheme(initial);
    document.documentElement.classList.toggle("dark", initial === "dark");
  }, []);

  useEffect(() => {
    if (!selectedPreview) return;
    const handleKey = (event) => {
      if (event.key === "Escape") {
        setSelectedPreview(null);
        return;
      }
      if (event.key === "ArrowRight") {
        setPreviewIndex((prev) =>
          previewItems.length ? (prev + 1) % previewItems.length : prev,
        );
      }
      if (event.key === "ArrowLeft") {
        setPreviewIndex((prev) =>
          previewItems.length
            ? (prev - 1 + previewItems.length) % previewItems.length
            : prev,
        );
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selectedPreview, previewItems.length]);

  useEffect(() => {
    const entries = loadHistory();
    setHistoryEntries(entries);
    setSelectedHistoryId(entries[0]?.id || null);
  }, []);

  useEffect(() => {
    let isActive = true;
    const createdUrls = [];

    async function loadHistoryPreviews() {
      if (!historyDetail) return;
      setHistoryPreviewUrls({});
      setHistoryPreviewCount(8);

      for (const item of historyDetail.items) {
        for (const device of item.devices || []) {
          const blob = await loadPreviewBlob(device.key);
          if (!isActive) return;
          const url = blob ? URL.createObjectURL(blob) : null;
          if (url) createdUrls.push(url);
          setHistoryPreviewUrls((prev) => ({
            ...prev,
            [device.key]: url,
          }));
        }
      }
    }

    loadHistoryPreviews();

    return () => {
      isActive = false;
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [historyDetailId]);

  useEffect(() => {
    if (!Number.isFinite(progressPercent)) return;
    targetPercentRef.current = progressPercent;
  }, [progressPercent]);

  useEffect(() => {
    const animate = () => {
      const current = displayPercentRef.current;
      const target = targetPercentRef.current;
      const diff = target - current;
      if (Math.abs(diff) < 0.2) {
        displayPercentRef.current = target;
        setDisplayPercent(target);
      } else {
        const step = Math.sign(diff) * Math.min(Math.abs(diff) * 0.08, 0.35);
        const next = current + step;
        displayPercentRef.current = next;
        setDisplayPercent(next);
      }
      progressRafRef.current = requestAnimationFrame(animate);
    };

    progressRafRef.current = requestAnimationFrame(animate);
    return () => {
      if (progressRafRef.current) {
        cancelAnimationFrame(progressRafRef.current);
        progressRafRef.current = null;
      }
    };
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    window.localStorage.setItem("theme", next);
    document.documentElement.classList.toggle("dark", next === "dark");
  }

  function toggleDevice(deviceId) {
    setSelectedDeviceIds((prev) => {
      if (prev.includes(deviceId)) {
        return prev.filter((id) => id !== deviceId);
      }
      return [...prev, deviceId];
    });
  }

  const selectedDevices = useMemo(() => {
    const selected = DEVICE_PRESETS.filter((device) =>
      selectedDeviceIds.includes(device.id),
    );
    return selected.length
      ? selected
      : DEVICE_PRESETS.filter((device) =>
          ["desktop", "mobile"].includes(device.id),
        );
  }, [selectedDeviceIds]);

  const allDevices = useMemo(() => {
    return [...selectedDevices, ...customSizes];
  }, [selectedDevices, customSizes]);

  function parseDetachSelectors(value) {
    return value
      .split(/\n|,/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  function addDetachSelectors() {
    const parsed = parseDetachSelectors(detachSelectorsInput);
    if (!parsed.length) return;
    setDetachSelectors((prev) => {
      const existing = new Set(prev);
      const next = [...prev];
      parsed.forEach((selector) => {
        if (!existing.has(selector)) next.push(selector);
      });
      return next;
    });
    setDetachSelectorsInput("");
  }

  function removeDetachSelector(selector) {
    setDetachSelectors((prev) => prev.filter((item) => item !== selector));
  }

  function addCustomSizes() {
    if (!customSizeInput.trim()) return;
    const tokens = customSizeInput.split(/[,\s]+/).filter(Boolean);
    const parsed = [];

    tokens.forEach((token) => {
      const match = token.toLowerCase().match(/(\d+)\s*[x×]\s*(\d+)/);
      if (!match) return;
      const width = Number.parseInt(match[1], 10);
      const height = Number.parseInt(match[2], 10);
      if (!Number.isFinite(width) || !Number.isFinite(height)) return;
      const id = `custom_${width}x${height}`;
      parsed.push({
        id,
        label: `Custom ${width}×${height}`,
        width,
        height,
        isCustom: true,
      });
    });

    if (parsed.length) {
      setCustomSizes((prev) => {
        const existing = new Set(prev.map((item) => item.id));
        const next = [...prev];
        parsed.forEach((item) => {
          if (!existing.has(item.id)) next.push(item);
        });
        return next;
      });
      setCustomSizeInput("");
    }
  }

  function openPreview(list, index) {
    setPreviewItems(list);
    setPreviewIndex(index);
    setSelectedPreview(list[index]);
  }

  function goPreview(offset) {
    if (!previewItems.length) return;
    const nextIndex =
      (previewIndex + offset + previewItems.length) % previewItems.length;
    setPreviewIndex(nextIndex);
    setSelectedPreview(previewItems[nextIndex]);
  }

  function removeCustomSize(id) {
    setCustomSizes((prev) => prev.filter((item) => item.id !== id));
  }

  async function startExport() {
    setMessage("Preparing export...");
    setIsLoading(true);
    setStatus({
      stage: "starting",
      message: "Starting export…",
      completed: 0,
      total: 0,
      currentUrl: "",
    });
    setLogs([]);
    setDownloadReady(false);
    setDownloadJob({ jobId: null, name: null, blobKey: null });
    setPreviews([]);
    setPreviewError("");
    setSelectedPreview(null);
    setVisiblePreviewCount(6);
    setView("export");
    if (previewUrlsRef.current.length) {
      previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      previewUrlsRef.current = [];
    }

    try {
      const response = await fetch("/api/export/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          options: {
            devices: allDevices,
            hideSticky,
            detachSelectors,
          },
        }),
      });

      if (!response.ok) {
        if (response.status === 404) {
          await runLegacyExport();
          return;
        }
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Export failed.");
      }

      const payload = await response.json();
      const { jobId } = payload;
      if (!jobId) throw new Error("Export job was not created.");

      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const eventSource = new EventSource(`/api/export/stream/${jobId}`);
      eventSourceRef.current = eventSource;

      eventSource.addEventListener("progress", (event) => {
        const data = JSON.parse(event.data || "{}");
        setStatus((prev) => ({
          stage: data.stage || prev.stage,
          message: data.message || prev.message,
          completed: Number.isFinite(data.completed)
            ? data.completed
            : prev.completed,
          total: Number.isFinite(data.total) ? data.total : prev.total,
          currentUrl: data.currentUrl || prev.currentUrl,
        }));
        if (data.message) {
          setLogs((prev) => [data.message, ...prev].slice(0, 6));
        }
      });

      eventSource.addEventListener("failed", (event) => {
        const data = JSON.parse(event.data || "{}");
        setMessage(`Error: ${data.error || "Export failed."}`);
        setStatus((prev) => ({ ...prev, stage: "error" }));
        setIsLoading(false);
        eventSource.close();
      });

      eventSource.addEventListener("done", async (event) => {
        const data = JSON.parse(event.data || "{}");
        setMessage("Export complete. Ready to download.");
        eventSource.close();
        setDownloadReady(true);
        setDownloadJob({
          jobId,
          name: data.archiveName || "website_exports.zip",
          blobKey: null,
        });
        setStatus((prev) => ({ ...prev, stage: "done" }));
        setIsLoading(false);
        const items = await fetchPreviews(jobId);
        if (items.length) {
          await persistHistory(items, jobId);
        }
      });

      eventSource.addEventListener("error", () => {
        setMessage("Connection lost while waiting for progress updates.");
      });
    } catch (error) {
      setMessage(`Error: ${error.message}`);
      setStatus((prev) => ({ ...prev, stage: "error" }));
      setIsLoading(false);
    }
  }

  async function runLegacyExport() {
    setStatus((prev) => ({
      ...prev,
      stage: "fallback",
      message: "Running legacy export (no live progress)…",
    }));
    setMessage("Running legacy export (no live progress)…");

    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          options: {
            devices: allDevices,
            hideSticky,
          detachSelectors,
          },
        }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Export failed.");
    }

    const blob = await response.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const contentDisposition = response.headers.get("Content-Disposition") || "";
    const fileNameMatch = contentDisposition.match(/filename=\"?([^\"]+)\"?/i);
    const fileName = fileNameMatch?.[1] || "website_exports.zip";
    setDownloadReady(true);
    setDownloadJob({
      jobId: null,
      name: fileName,
      legacyUrl: downloadUrl,
      blobKey: null,
    });
    setMessage("Export complete. Ready to download.");
    setStatus((prev) => ({ ...prev, stage: "done" }));
    setIsLoading(false);
    setPreviewError("Preview gallery is unavailable in legacy mode.");
  }

  async function fetchPreviews(jobId) {
    try {
      const response = await fetch(`/api/export/previews/${jobId}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Failed to load previews.");
      }
      const payload = await response.json();
      const items = payload.items || [];
      const createdUrls = [];
      const hydrated = [];

      for (const item of items) {
        const devices = [];
        for (const device of item.devices || []) {
          const previewResponse = await fetch(device.url);
          if (!previewResponse.ok) continue;
          const blob = await previewResponse.blob();
          const localUrl = URL.createObjectURL(blob);
          createdUrls.push(localUrl);
          devices.push({ ...device, blob, localUrl });
        }
        hydrated.push({ ...item, devices });
      }

      if (previewUrlsRef.current.length) {
        previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      }
      previewUrlsRef.current = createdUrls;

      setPreviews(hydrated);
      setVisiblePreviewCount(Math.min(6, items.length));
      if (!items.length) {
        setPreviewError("No previews available for this export.");
      }
      return hydrated;
    } catch (error) {
      setPreviewError(error.message);
      return [];
    }
  }

  async function persistHistory(items, jobId) {
    setIsSavingHistory(true);
    try {
      const entryId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const entryItems = [];
      const zipKey = createZipKey(entryId);

      for (const item of items) {
        const deviceEntries = [];
        for (const device of item.devices || []) {
          const blob =
            device.blob ||
            (await fetch(device.url).then((response) => response.blob()));
          const key = createPreviewKey(
            entryId,
            `${item.id}_${device.id}`,
            "preview",
          );
          await storePreviewBlob(key, blob);
          deviceEntries.push({
            id: device.id,
            label: device.label,
            key,
          });
        }

        entryItems.push({
          id: item.id,
          title: item.displayTitle || item.title,
          pageUrl: item.pageUrl,
          devices: deviceEntries,
        });
      }

      if (jobId) {
        const zipBlob = await fetchZipBlob(jobId);
        if (zipBlob) {
          await storePreviewBlob(zipKey, zipBlob);
          setDownloadJob((prev) => ({
            ...prev,
            blobKey: zipKey,
            jobId: null,
          }));
        }
      }

      const entry = {
        id: entryId,
        siteUrl: url,
        siteName: getSiteName(url),
        createdAt,
        itemCount: entryItems.length,
        zipKey,
        items: entryItems,
        devices: selectedDevices.map((device) => ({
          id: device.id,
          label: device.label,
          width: device.width,
          height: device.height,
        })),
      };
      const updated = [entry, ...historyEntries].slice(0, MAX_HISTORY);
      saveHistory(updated);
      setHistoryEntries(updated);
      setSelectedHistoryId(entryId);
      setHistoryDetailId(entryId);
    } catch (error) {
      setPreviewError(`Saved export, but failed to store history: ${error.message}`);
    } finally {
      setIsSavingHistory(false);
    }
  }

  async function deleteHistoryEntry(entry) {
    if (!entry) return;
    try {
      if (entry.zipKey) {
        await removeStoredBlob(entry.zipKey);
      }
      for (const item of entry.items || []) {
        for (const device of item.devices || []) {
          await removeStoredBlob(device.key);
        }
      }
    } catch {
      // ignore cleanup failures
    }

    const updated = historyEntries.filter((item) => item.id !== entry.id);
    saveHistory(updated);
    setHistoryEntries(updated);
    setDeleteTarget(null);

    if (historyDetailId === entry.id) {
      setHistoryDetailId(null);
    }
    if (selectedHistoryId === entry.id) {
      setSelectedHistoryId(updated[0]?.id || null);
    }
  }

  function startEditEntry(entry) {
    setEditEntryId(entry.id);
    setEditEntryValue(entry.siteName || getSiteName(entry.siteUrl));
  }

  function cancelEditEntry() {
    setEditEntryId(null);
    setEditEntryValue("");
  }

  function saveEditEntry(entry) {
    const updatedName = editEntryValue.trim() || getSiteName(entry.siteUrl);
    const updated = historyEntries.map((item) =>
      item.id === entry.id ? { ...item, siteName: updatedName } : item,
    );
    saveHistory(updated);
    setHistoryEntries(updated);
    setEditEntryId(null);
    setEditEntryValue("");
  }

  async function handleDownload() {
    if (!downloadReady) return;
    setIsDownloading(true);
    try {
      if (downloadJob.blobKey) {
        const blob = await loadZipBlob(downloadJob.blobKey);
        if (blob) {
          triggerBlobDownload(blob, downloadJob.name || "website_exports.zip");
          setMessage("Download started.");
          return;
        }
      }
      if (downloadJob.legacyUrl) {
        const link = document.createElement("a");
        link.href = downloadJob.legacyUrl;
        link.download = downloadJob.name || "website_exports.zip";
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(downloadJob.legacyUrl);
      } else if (downloadJob.jobId) {
        await downloadZip(downloadJob.jobId, downloadJob.name);
      }
      setMessage("Download started.");
    } catch (error) {
      setMessage(`Error: ${error.message}`);
    } finally {
      setIsDownloading(false);
    }
  }

  async function downloadZip(jobId, suggestedName) {
    const response = await fetch(`/api/export/download/${jobId}`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Failed to download export.");
    }

    const blob = await response.blob();
    const contentDisposition = response.headers.get("Content-Disposition") || "";
    const fileNameMatch = contentDisposition.match(/filename=\"?([^\"]+)\"?/i);
    const fileName = fileNameMatch?.[1] || suggestedName || "website_exports.zip";
    triggerBlobDownload(blob, fileName);
  }

  async function fetchZipBlob(jobId) {
    const response = await fetch(`/api/export/download/${jobId}`);
    if (!response.ok) {
      return null;
    }
    return response.blob();
  }

  function triggerBlobDownload(blob, fileName) {
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(downloadUrl);
  }

  function sanitizeFileName(value) {
    return (value || "screenshot")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80);
  }

  async function downloadImage(url, label) {
    if (!url) return;
    const response = await fetch(url);
    if (!response.ok) return;
    const blob = await response.blob();
    const base = sanitizeFileName(selectedPreview?.title || "page");
    const fileName = `${base}_${sanitizeFileName(label)}.jpg`;
    triggerBlobDownload(blob, fileName);
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  function getSiteName(rawUrl) {
    if (!rawUrl) return "Website";
    try {
      const normalized = rawUrl.startsWith("http")
        ? rawUrl
        : `https://${rawUrl}`;
      return new URL(normalized).hostname.replace(/^www\./, "");
    } catch {
      return rawUrl;
    }
  }

  const currentPreviewSlice = previews.slice(0, visiblePreviewCount);
  const historyPreviewSlice = historyDetail
    ? historyDetail.items.slice(0, historyPreviewCount)
    : [];

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="sticky top-0 hidden h-screen w-72 flex-col border-r bg-card/70 backdrop-blur md:flex">
        <button
          className="flex items-center gap-2 px-5 pt-5 text-left text-lg font-semibold transition hover:text-foreground"
          onClick={() => setView("capture")}
        >
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Camera className="h-5 w-5" />
          </div>
          Capture Studio
        </button>

        <div className="relative mt-6 flex-1 overflow-hidden">
          <div
            className={`absolute inset-0 space-y-2 px-4 transition-all duration-300 ${
              view === "history"
                ? "-translate-x-full opacity-0"
                : "translate-x-0 opacity-100"
            }`}
          >
            <button
              className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition hover:-translate-y-0.5 ${
                view === "capture"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              }`}
              onClick={() => setView("capture")}
            >
              <Camera className="h-4 w-4" />
              Capture
            </button>
            <button
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground transition hover:-translate-y-0.5 hover:bg-muted/60 hover:text-foreground"
              onClick={() => setView("history")}
            >
              <History className="h-4 w-4" />
              History
            </button>
          </div>

          <div
            className={`absolute inset-0 flex h-full flex-col px-4 transition-all duration-300 ${
              view === "history"
                ? "translate-x-0 opacity-100"
                : "translate-x-full opacity-0"
            }`}
          >
            <button
              className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground transition hover:-translate-y-0.5 hover:bg-muted/60 hover:text-foreground"
              onClick={() => setView("capture")}
            >
              ← Back
            </button>
            <div className="mt-3 text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
              History
            </div>
            <div className="mt-3 flex-1 space-y-2 overflow-auto pb-4">
              {historyEntries.length ? (
                historyEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className={`flex items-center justify-between rounded-2xl border px-3 py-2 text-left text-xs transition hover:-translate-y-0.5 ${
                      selectedHistoryId === entry.id
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    }`}
                  >
                    <button
                      className="flex-1 text-left"
                      onClick={() => {
                        setSelectedHistoryId(entry.id);
                        setHistoryDetailId(entry.id);
                      }}
                    >
                      {editEntryId === entry.id ? (
                        <input
                          className="w-full rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground"
                          value={editEntryValue}
                          onChange={(event) =>
                            setEditEntryValue(event.target.value)
                          }
                          onClick={(event) => event.stopPropagation()}
                        />
                      ) : (
                        <div className="truncate font-semibold">
                          {entry.siteName || getSiteName(entry.siteUrl)}
                        </div>
                      )}
                      <div className="mt-1 text-[10px] text-muted-foreground">
                        {formatDate(entry.createdAt)}
                      </div>
                    </button>
                    <div className="ml-2 flex items-center gap-1">
                      {editEntryId === entry.id ? (
                        <>
                          <button
                            className="rounded-full p-1 text-muted-foreground transition hover:text-foreground"
                            onClick={(event) => {
                              event.stopPropagation();
                              saveEditEntry(entry);
                            }}
                            aria-label="Save name"
                          >
                            <Check className="h-4 w-4" />
                          </button>
                          <button
                            className="rounded-full p-1 text-muted-foreground transition hover:text-foreground"
                            onClick={(event) => {
                              event.stopPropagation();
                              cancelEditEntry();
                            }}
                            aria-label="Cancel edit"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="rounded-full p-1 text-muted-foreground transition hover:text-foreground"
                            onClick={(event) => {
                              event.stopPropagation();
                              startEditEntry(entry);
                            }}
                            aria-label="Edit name"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            className="rounded-full p-1 text-muted-foreground transition hover:text-foreground"
                            onClick={(event) => {
                              event.stopPropagation();
                              setDeleteTarget(entry);
                            }}
                            aria-label="Delete export"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">
                  No saved exports yet.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="mt-auto space-y-4 px-5 pb-5">
          <button
            className="flex w-full items-center justify-between rounded-xl border border-border px-3 py-2 text-sm font-medium text-muted-foreground transition hover:-translate-y-0.5 hover:bg-muted/60 hover:text-foreground"
            onClick={toggleTheme}
          >
            {theme === "dark" ? "Dark mode" : "Light mode"}
            {theme === "dark" ? (
              <Moon className="h-4 w-4" />
            ) : (
              <Sun className="h-4 w-4" />
            )}
          </button>
          <p className="text-xs text-muted-foreground">
            Exports are stored locally in this browser.
          </p>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-6 py-10">
          {view === "capture" && (
            <section className="flex flex-col items-center gap-6 transition-all duration-300">
              <div className="relative w-full max-w-5xl rounded-3xl border border-border bg-card/80 p-10 shadow-xl shadow-black/10 backdrop-blur">
                <div className="flex flex-wrap items-start justify-between gap-6">
                  <div className="max-w-2xl space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
                      Website Capture Suite
                    </p>
                    <h1 className="text-3xl font-semibold md:text-4xl">
                      Capture any site, full‑page
                    </h1>
                    <p className="text-muted-foreground">
                      Paste a website URL (or sitemap.xml URL), then export
                      stitched PDFs for desktop and mobile.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 rounded-full border border-border bg-muted/60 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.8)]" />
                    {isLoading ? "Processing" : "Ready"}
                  </div>
                </div>

                <div className="mt-8 grid gap-4 lg:grid-cols-[1fr_auto]">
                  <input
                    className="h-12 rounded-xl border border-input bg-background px-4 text-sm text-foreground shadow-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                    placeholder="https://example.com or https://example.com/sitemap.xml"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    disabled={isLoading}
                  />
                  <button
                    className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-primary px-6 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={startExport}
                    disabled={isLoading || !url.trim() || selectedDevices.length === 0}
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Running…
                      </>
                    ) : (
                      "Start Export"
                    )}
                  </button>
                </div>
                  <div className="mt-4 flex flex-wrap items-center gap-4">
                  <button
                    className="rounded-full border border-border px-4 py-2 text-xs font-semibold text-muted-foreground transition hover:-translate-y-0.5 hover:bg-muted/60 hover:text-foreground"
                    onClick={() => setAdvancedOpen((prev) => !prev)}
                  >
                    Advanced options
                  </button>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.8)]" />
                    <span>Active:</span>
                    <div className="flex flex-wrap items-center gap-2">
                      {allDevices.map((device) => (
                        <span
                          key={device.id}
                          className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold text-foreground"
                        >
                          {device.label}
                        </span>
                      ))}
                    </div>
                    {detachSelectors.length ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Detached:
                        </span>
                        {detachSelectors.map((selector) => (
                          <span
                            key={selector}
                            className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-semibold text-foreground"
                          >
                            {selector}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>

              </div>

              <div
                className={`w-full max-w-5xl overflow-hidden transition-all duration-300 ${
                  advancedOpen
                    ? "max-h-[720px] translate-y-0 opacity-100"
                    : "pointer-events-none max-h-0 -translate-y-2 opacity-0"
                }`}
              >
                <div className="rounded-2xl border border-border bg-background/90 p-6 backdrop-blur">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
                        Advanced
                      </p>
                      <h3 className="text-lg font-semibold">Devices</h3>
                    </div>
                    <button
                      className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
                      onClick={() => setAdvancedOpen(false)}
                    >
                      Close
                    </button>
                  </div>

                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {DEVICE_PRESETS.map((device) => {
                      const active = selectedDeviceIds.includes(device.id);
                      return (
                        <button
                          key={device.id}
                          className={`flex items-center justify-between rounded-xl border px-3 py-2 text-left text-xs transition hover:-translate-y-0.5 ${
                            active
                              ? "border-emerald-400/50 bg-emerald-400/10 text-foreground"
                              : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                          }`}
                          onClick={() => toggleDevice(device.id)}
                        >
                          <div className="font-semibold">{device.label}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {device.width}×{device.height}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  <div className="mt-5 rounded-xl border border-border bg-background/60 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
                      Custom sizes
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <input
                        className="h-10 flex-1 rounded-xl border border-border bg-background px-3 text-xs text-foreground shadow-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                        placeholder="1280x720, 1440x900"
                        value={customSizeInput}
                        onChange={(event) => setCustomSizeInput(event.target.value)}
                      />
                      <button
                        className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition hover:opacity-90"
                        onClick={addCustomSizes}
                      >
                        Add
                      </button>
                    </div>
                    {customSizes.length ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {customSizes.map((size) => (
                          <span
                            key={size.id}
                            className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[10px] font-semibold text-foreground"
                          >
                            {size.width}×{size.height}
                            <button
                              className="text-foreground/70 transition hover:text-foreground"
                              onClick={() => removeCustomSize(size.id)}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-[10px] text-muted-foreground">
                        Add as many sizes as you want. Use “widthxheight”.
                      </p>
                    )}
                  </div>

                  <div className="mt-5 rounded-xl border border-border bg-background/60 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
                      Detach elements
                    </p>
                    <p className="mt-2 text-[10px] text-muted-foreground">
                      Provide CSS selectors. We will remove them from the page
                      and capture each element separately.
                    </p>
                    {detachSelectors.length ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {detachSelectors.map((selector) => (
                          <span
                            key={selector}
                            className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-semibold text-foreground"
                          >
                            {selector}
                            <button
                              className="text-foreground/60 transition hover:text-foreground"
                              onClick={() => removeDetachSelector(selector)}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <textarea
                      className="mt-3 h-24 w-full rounded-xl border border-border bg-background px-3 py-2 text-xs text-foreground shadow-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder=".cookie-banner, #promo, .floating-chat"
                      value={detachSelectorsInput}
                      onChange={(event) =>
                        setDetachSelectorsInput(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          addDetachSelectors();
                        }
                      }}
                    />
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition hover:opacity-90"
                        onClick={addDetachSelectors}
                      >
                        Add selectors
                      </button>
                      <p className="text-[10px] text-muted-foreground">
                        Press Enter to add (Shift+Enter for a new line).
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 rounded-xl border border-border bg-background/60 p-3">
                    <div className="flex items-center justify-between text-xs font-semibold text-muted-foreground">
                      <span>Hide sticky elements</span>
                      <button
                        className={`flex h-5 w-10 items-center rounded-full transition ${
                          hideSticky ? "bg-emerald-400" : "bg-muted"
                        }`}
                        onClick={() => setHideSticky((prev) => !prev)}
                        aria-label="Toggle sticky elements"
                      >
                        <span
                          className={`h-4 w-4 rounded-full bg-white shadow transition ${
                            hideSticky ? "translate-x-5" : "translate-x-1"
                          }`}
                        />
                      </button>
                    </div>
                    <p className="mt-2 text-[10px] text-muted-foreground">
                      Applies to all selected devices.
                    </p>
                  </div>
                </div>
              </div>
            </section>
          )}

          {view === "export" && (
            <section className="grid gap-8 transition-all duration-300">
              <div className="rounded-3xl border border-border bg-card p-8 shadow-xl shadow-black/10">
                <div className="flex flex-wrap items-start justify-between gap-6">
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
                      Export Status
                    </p>
                    <h2 className="text-2xl font-semibold">
                      {status.stage === "done" ? "Export complete" : "Exporting…"}
                    </h2>
                    <p className="text-muted-foreground">
                      {status.message || message}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <button
                      className="inline-flex h-11 items-center gap-2 rounded-xl border border-border bg-background px-4 text-sm font-semibold text-foreground shadow-sm transition hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={handleDownload}
                      disabled={!downloadReady || isDownloading}
                    >
                      <Download className="h-4 w-4" />
                      {isDownloading ? "Preparing…" : "Download ZIP"}
                    </button>
                    <button
                      className="inline-flex h-11 items-center gap-2 rounded-xl border border-border px-4 text-sm font-semibold text-muted-foreground transition hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() => setView("capture")}
                      disabled={isLoading}
                    >
                      Start another export
                    </button>
                  </div>
                </div>

                <div className="mt-6 grid gap-4">
                  <div className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
                    <span>
                      {status.completed}/{status.total || "–"} pages
                    </span>
                    <span className="text-xl font-semibold text-foreground">
                      {Math.round(displayPercent)}%
                    </span>
                  </div>
                  <div className="h-3 w-full rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-lime-300 to-emerald-500 shadow-[0_0_18px_rgba(16,185,129,0.7)] transition-all"
                      style={{ width: `${Math.min(100, Math.max(0, displayPercent))}%` }}
                    />
                  </div>
                  {status.currentUrl ? (
                    <p className="text-xs text-muted-foreground">
                      Working on: {status.currentUrl}
                    </p>
                  ) : null}
                  {isSavingHistory ? (
                    <p className="text-xs text-muted-foreground">
                      Saving previews to your library…
                    </p>
                  ) : null}
                </div>

                <div className="mt-6 grid gap-2 text-xs text-muted-foreground">
                  {logs.length ? (
                    logs.map((log, index) => (
                      <div key={`${log}-${index}`}>• {log}</div>
                    ))
                  ) : (
                    <div>Awaiting updates…</div>
                  )}
                </div>
              </div>

              <div className="rounded-3xl border border-border bg-card p-8 shadow-xl shadow-black/10">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold">Preview gallery</h3>
                    <p className="text-sm text-muted-foreground">
                      Desktop and mobile snapshots for every page.
                    </p>
                  </div>
                </div>
                {previewError ? (
                  <p className="mt-4 text-sm text-red-400">{previewError}</p>
                ) : null}
                <div className="mt-6 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                  {currentPreviewSlice.map((item) => (
                    <button
                      key={item.id}
                      className="group rounded-2xl border border-border bg-background p-5 text-left transition hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-lg hover:shadow-black/10"
                      onClick={() =>
                        openPreview(
                          previews.map((previewItem) => ({
                            id: previewItem.id,
                            title: previewItem.displayTitle || previewItem.title,
                            pageUrl: previewItem.pageUrl,
                            devices: previewItem.devices || [],
                          })),
                          previews.findIndex(
                            (previewItem) => previewItem.id === item.id,
                          ),
                        )
                      }
                    >
                      <div className="space-y-1">
                        <p className="text-sm font-semibold">
                          {item.displayTitle || item.title}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {item.pageUrl}
                        </p>
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-3">
                        {(item.devices || []).map((device) => (
                          <div
                            key={device.id}
                            className="relative overflow-hidden rounded-xl border border-border"
                          >
                            <img
                              src={device.localUrl || device.url}
                              alt={`${item.title} ${device.label}`}
                              className="h-32 w-full object-cover object-top"
                            />
                            <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold text-white">
                              {device.label}
                            </span>
                          </div>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
                {previews.length > visiblePreviewCount ? (
                  <div className="mt-6 flex justify-center">
                    <button
                      className="rounded-full border border-border px-4 py-2 text-sm font-semibold text-muted-foreground transition hover:bg-muted/60 hover:text-foreground hover:shadow-lg hover:shadow-emerald-500/10"
                      onClick={() =>
                        setVisiblePreviewCount((count) =>
                          Math.min(count + 6, previews.length),
                        )
                      }
                    >
                      Load more previews
                    </button>
                  </div>
                ) : null}
              </div>
            </section>
          )}

          {view === "history" && (
            <section className="grid gap-6 transition-all duration-300">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
                    History
                  </p>
                  <h2 className="text-2xl font-semibold">Saved exports</h2>
                  <p className="text-sm text-muted-foreground">
                    Browse previous exports stored on this device.
                  </p>
                </div>
              </div>

              {!historyDetail ? (
                <div className="grid gap-3">
                  <p className="text-sm text-muted-foreground">
                    Pick an export from the sidebar to view details.
                  </p>
                </div>
              ) : (
                <div className="rounded-3xl border border-border bg-card p-6 shadow-xl shadow-black/5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-semibold">
                        {historyDetail.siteName ||
                          getSiteName(historyDetail.siteUrl)}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {formatDate(historyDetail.createdAt)} •{" "}
                        {historyDetail.itemCount} pages
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {historyDetail.siteUrl}
                      </p>
                    </div>
                    <button
                      className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-background px-4 text-sm font-semibold text-foreground shadow-sm transition hover:-translate-y-0.5 hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={async () => {
                        if (!historyDetail.zipKey) return;
                        const blob = await loadZipBlob(historyDetail.zipKey);
                        if (blob) {
                          triggerBlobDownload(
                            blob,
                            `${historyDetail.siteUrl
                              .replace(/https?:\/\//, "")
                              .replace(/[^a-z0-9]+/gi, "_")}_exports.zip`,
                          );
                        }
                      }}
                      disabled={!historyDetail.zipKey}
                    >
                      <Download className="h-4 w-4" />
                      Download ZIP
                    </button>
                  </div>

                  <div className="mt-6 grid gap-4 md:grid-cols-2">
                    {historyPreviewSlice.map((item) => {
                      const devices = (item.devices || []).map((device) => ({
                        id: device.id,
                        label: device.label,
                        url: historyPreviewUrls[device.key],
                      }));
                      return (
                        <button
                          key={item.id}
                          className="rounded-2xl border border-border bg-background p-4 text-left transition hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-lg hover:shadow-black/10"
                          onClick={() =>
                            openPreview(
                              historyPreviewItems,
                              historyPreviewItems.findIndex(
                                (previewItem) => previewItem.id === item.id,
                              ),
                            )
                          }
                        >
                          <div className="space-y-1">
                            <p className="text-sm font-semibold">
                              {item.title}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {item.pageUrl}
                            </p>
                          </div>
                          <div className="mt-4 grid grid-cols-2 gap-3">
                            {devices.map((device) => (
                              <div
                                key={device.id}
                                className="relative overflow-hidden rounded-xl border border-border bg-muted/40"
                              >
                                {device.url ? (
                                  <img
                                    src={device.url}
                                    alt={`${item.title} ${device.label}`}
                                    className="h-28 w-full object-cover object-top"
                                  />
                                ) : (
                                  <div className="flex h-28 items-center justify-center text-xs text-muted-foreground">
                                    Loading…
                                  </div>
                                )}
                                <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold text-white">
                                  {device.label}
                                </span>
                              </div>
                            ))}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  {historyDetail.items.length > historyPreviewCount ? (
                    <div className="mt-6 flex justify-center">
                      <button
                        className="rounded-full border border-border px-4 py-2 text-sm font-semibold text-muted-foreground transition hover:bg-muted/60 hover:text-foreground hover:shadow-lg hover:shadow-emerald-500/10"
                        onClick={() =>
                          setHistoryPreviewCount((count) =>
                            Math.min(
                              count + 8,
                              historyDetail.items.length,
                            ),
                          )
                        }
                      >
                        Load more pages
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </section>
          )}
        </div>
      </main>

      {selectedPreview ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-6"
          onClick={() => setSelectedPreview(null)}
        >
          <button
            className="absolute left-6 top-1/2 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/30 text-white/80 transition hover:bg-white/10 hover:text-white md:flex"
            onClick={(event) => {
              event.stopPropagation();
              goPreview(-1);
            }}
          >
            ←
          </button>
          <button
            className="absolute right-6 top-1/2 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/30 text-white/80 transition hover:bg-white/10 hover:text-white md:flex"
            onClick={(event) => {
              event.stopPropagation();
              goPreview(1);
            }}
          >
            →
          </button>
          <div
            className="relative max-h-[90vh] w-full max-w-6xl overflow-auto rounded-3xl border border-border bg-card p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold text-white">
                    {selectedPreview.title}
                  </h3>
                  <p className="text-sm text-white/90">
                    {selectedPreview.pageUrl}
                  </p>
                </div>
                <button
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-white/30 text-white/80 transition hover:bg-white/10 hover:text-white"
                  onClick={() => setSelectedPreview(null)}
                >
                  ×
                </button>
              </div>
            <div className="mt-6 grid gap-6 md:grid-cols-2">
              {(selectedPreview.devices || []).map((device) => (
                <div key={device.id} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wide text-white/60">
                      {device.label}
                    </p>
                    <button
                      className="rounded-full border border-white/30 px-3 py-1 text-[10px] font-semibold text-white/80 transition hover:bg-white/10 hover:text-white"
                      onClick={() =>
                        downloadImage(device.localUrl || device.url, device.label)
                      }
                    >
                      Save
                    </button>
                  </div>
                  <img
                    src={device.localUrl || device.url}
                    alt={`${selectedPreview.title} ${device.label}`}
                    className="w-full rounded-2xl border border-border object-top"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {deleteTarget ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-6"
          onClick={() => setDeleteTarget(null)}
        >
          <div
            className="w-full max-w-md rounded-3xl border border-white/10 bg-black/80 p-6 text-white shadow-xl shadow-black/30 backdrop-blur"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white">
              Delete export?
            </h3>
            <p className="mt-2 text-sm text-white/80">
              This removes the saved previews and ZIP for{" "}
              <span className="font-semibold text-white">
                {deleteTarget.siteUrl}
              </span>
              .
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                className="rounded-full border border-white/30 px-4 py-2 text-sm font-semibold text-white/80 transition hover:bg-white/10 hover:text-white"
                onClick={() => setDeleteTarget(null)}
              >
                Cancel
              </button>
              <button
                className="rounded-full bg-red-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-400"
                onClick={() => deleteHistoryEntry(deleteTarget)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);

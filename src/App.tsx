import React, { useEffect, useMemo, useRef, useState } from "react";

/** Material Symbols（Outlined）を読み込み */
const ensureMaterialSymbols = () => {
  const id = "ms-outlined-css";
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href =
    "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0..1,0";
  document.head.appendChild(link);
};

/** YouTube IFrame API を一度だけ読み込み */
const loadYouTubeAPI = () => {
  if (typeof window === "undefined") return;
  if ((window as any).YT && (window as any).YT.Player) return;
  const existing = document.querySelector(
    'script[src="https://www.youtube.com/iframe_api"]'
  );
  if (existing) return;
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
};

/** 型 */
interface WordRow {
  t: number;         // 開始秒
  word: string;      // 見出し語（空でもOK）
  level: 0 | 1;      // 0=未習, 1=既知
}
interface Segment {
  start: number;
  end: number;       // 次の開始 - EPS or フォールバック
  word: string;
  level: 0 | 1;      // 該当 WordRow の level を持たせる
}
interface DatasetMeta {
  id: string;
  title: string;     // YouTube動画タイトル（自動取得）
  createdAt: number;
}
interface DatasetDataV2 {
  schema: 2;
  id: string;
  title: string;
  videoId: string;
  words: WordRow[];  // ← 保存はこれだけ（+メタ）
  windowSec: number;
  createdAt: number;
}
// 互換読み取り用（旧）
interface LegacySegment { word: string; start: number; end: number; }
interface DatasetDataLegacy {
  id: string;
  title: string;
  videoId: string;
  segments: LegacySegment[];
  known: Record<string, boolean>; // key: word||t=sec
  windowSec: number;
  createdAt: number;
}

/** mm:ss(.ms) or seconds → seconds number */
const parseTime = (raw: string): number => {
  const s = raw.trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const mmss = s.split(":");
  if (mmss.length === 2) {
    const [m, sec] = mmss;
    return parseInt(m, 10) * 60 + parseFloat(sec);
  }
  if (mmss.length === 3) {
    const [h, m, sec] = mmss;
    return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(sec);
  }
  return Number(s) || 0;
};

/** CSV（軽量フォーマット）
 *  1行目: URL/ID
 *  2行目: 列名（例: 秒数,見出し語,習熟度）
 *  3行目以降: 秒数,見出し語(任意),習熟度(空白=0)
 *
 * 保存は words（t, word, level）のみ。end は保存しない。
 */
const parseUploadedCSV = (
  text: string
): { videoId: string; words: WordRow[] } => {
  const BOM = String.fromCharCode(65279);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(new RegExp("^" + BOM), "").trim());
  const cleaned = lines.filter((l) => l);
  if (cleaned.length < 3)
    throw new Error("CSVは3行以上（URL+ヘッダ+データ）にしてください。");

  const urlLine = cleaned[0].split(",")[0].trim();
  const videoId = extractVideoId(urlLine);
  if (!videoId)
    throw new Error("1行目に有効なYouTube URL/IDを入力してください。");

  const dataLines = cleaned.slice(2);
  const words: WordRow[] = [];
  for (const line of dataLines) {
    const parts = line.split(/,|\t/).map((s) => s.trim());
    if (!parts[0]) continue; // 秒数必須
    const t = parseTime(parts[0]);
    const word = (parts[1] || ``).trim();
    const lvlRaw = (parts[2] ?? "").trim();
    const level: 0 | 1 = (lvlRaw === "" ? 0 : parseInt(lvlRaw, 10) ? 1 : 0) as
      | 0
      | 1;
    if (!Number.isFinite(t)) continue;
    words.push({ t, word, level });
  }

  // 時刻でソート
  words.sort((a, b) => a.t - b.t);
  return { videoId, words };
};

/** URL/ID → videoId */
const extractVideoId = (urlOrId: string): string => {
  const s = urlOrId.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.includes("youtu.be")) return u.pathname.replace("/", "");
    if (u.searchParams.get("v")) return u.searchParams.get("v") || "";
  } catch {}
  return s;
};

/** YouTubeタイトル取得（oEmbed） */
const fetchVideoTitle = async (videoId: string): Promise<string> => {
  const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("oEmbed fetch failed");
    const json = await res.json();
    return (json?.title as string) || "NoName";
  } catch {
    return "NoName";
  }
};

/** LocalStorage helpers */
const INDEX_KEY = "yt-word-loop:index";
const DS_KEY = (id: string) => `yt-word-loop:ds:${id}`; // データ本体

const loadIndex = (): DatasetMeta[] => {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};
const saveIndex = (list: DatasetMeta[]) => {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));
  } catch {}
};
const saveDataset = (ds: DatasetDataV2) => {
  try {
    localStorage.setItem(DS_KEY(ds.id), JSON.stringify(ds));
  } catch {}
};
const loadDatasetAny = (
  id: string
): DatasetDataV2 | DatasetDataLegacy | null => {
  try {
    const raw = localStorage.getItem(DS_KEY(id));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};
const deleteDataset = (id: string) => {
  try {
    localStorage.removeItem(DS_KEY(id));
  } catch {}
};
const rid = () => Math.random().toString(36).slice(2, 10);

/** words → segments をメモリ上で構築 */
const makeSegments = (words: WordRow[], windowSec: number): Segment[] => {
  if (!words.length) return [];
  const EPS = 0.05;
  const sorted = [...words].sort((a, b) => a.t - b.t);
  const segs: Segment[] = sorted.map((w, i) => {
    const start = w.t;
    const nextStart = sorted[i + 1]?.t;
    const end = Number.isFinite(nextStart)
      ? Math.max(start, (nextStart as number) - EPS)
      : start + Math.max(0.3, windowSec);
    return { start, end, word: w.word || "", level: w.level };
  });
  return segs;
};

/** 16:9トップエリアのモード */
type TopMode = "select" | "help" | "video";

export default function App() {
  /** トップエリア */
  const [topMode, setTopMode] = useState<TopMode>("select");
  const [datasetList, setDatasetList] = useState<DatasetMeta[]>([]);
  const [windowSec, setWindowSec] = useState(1.8);

  /** 再生関連 */
  const [activeId, setActiveId] = useState<string | null>(null);
  const [videoId, setVideoId] = useState("");
  const [words, setWords] = useState<WordRow[]>([]); // ← 保存の主役
  const segments = useMemo(() => makeSegments(words, windowSec), [words, windowSec]);

  // 表示・再生対象のトグル：true=未習のみ / false=すべて
  const [unknownOnly, setUnknownOnly] = useState<boolean>(true);

  const playerRef = useRef<any>(null);
  const iframeWrap = useRef<HTMLDivElement>(null);
  const pollingRef = useRef<any>(null);
  const currentRef = useRef<{ idx: number } | null>(null);
  const csvFileInput = useRef<HTMLInputElement>(null);

  /** 起動 */
  useEffect(() => {
    ensureMaterialSymbols();
    loadYouTubeAPI();
    setDatasetList(loadIndex());
  }, []);

  /** プレイヤー構築（videoモード時） */
  const buildPlayer = () => {
    if (!iframeWrap.current || !videoId) return;
    if (!(window as any).YT || !(window as any).YT.Player) return;
    if (playerRef.current) {
      try { playerRef.current.destroy(); } catch {}
      playerRef.current = null;
    }
    playerRef.current = new (window as any).YT.Player(iframeWrap.current, {
      videoId,
      width: "100%",
      height: "100%",
      playerVars: { controls: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          try { playerRef.current.setPlaybackRate(1); } catch {}
        },
      },
    });
  };

  useEffect(() => {
    if (topMode !== "video" || !videoId) return;
    const tm = setInterval(() => {
      if ((window as any).YT && (window as any).YT.Player) {
        clearInterval(tm);
        buildPlayer();
      }
    }, 100);
    return () => clearInterval(tm);
  }, [topMode, videoId]);

  /** アップロード（CSV）→ 保存は words のみ */
  const onUploadClicked = () => csvFileInput.current?.click();

  const handleUpload: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const text = String(reader.result || "");
        const { videoId: vid, words } = parseUploadedCSV(text);
        const id = rid();
        const title = await fetchVideoTitle(vid);
        const meta: DatasetMeta = { id, title, createdAt: Date.now() };
        const data: DatasetDataV2 = {
          schema: 2,
          id,
          title,
          videoId: vid,
          words,
          windowSec,
          createdAt: meta.createdAt,
        };
        const nextList = [meta, ...datasetList];
        setDatasetList(nextList);
        saveIndex(nextList);
        saveDataset(data);
      } catch (err: any) {
        alert(err?.message || "CSVの読み込みに失敗しました");
      }
    };
    reader.readAsText(file);
    e.currentTarget.value = "";
  };

  /** 学習開始（旧スキーマは自動移行） */
  const migrateLegacy = (legacy: DatasetDataLegacy): DatasetDataV2 => {
    const words: WordRow[] = legacy.segments
      .sort((a, b) => a.start - b.start)
      .map((s) => {
        const key = s.word || `t=${s.start}`;
        const lvl: 0 | 1 = legacy.known?.[key] ? 1 : 0;
        return { t: s.start, word: s.word || "", level: lvl };
      });
    return {
      schema: 2,
      id: legacy.id,
      title: legacy.title,
      videoId: legacy.videoId,
      words,
      windowSec: legacy.windowSec || 1.8,
      createdAt: legacy.createdAt,
    };
  };

  const startLearning = (id: string) => {
    const raw = loadDatasetAny(id);
    if (!raw) return;

    let v2: DatasetDataV2;
    if ((raw as any).schema === 2) {
      v2 = raw as DatasetDataV2;
    } else {
      v2 = migrateLegacy(raw as DatasetDataLegacy);
      saveDataset(v2); // 上書き保存（自動移行）
    }

    setActiveId(v2.id);
    setVideoId(v2.videoId);
    setWords(v2.words || []);
    setWindowSec(v2.windowSec || 1.8);
    setTopMode("video");
  };

  /** ダウンロード（保存） */
  const downloadCSV = (id: string) => {
    const raw = loadDatasetAny(id);
    if (!raw) return;

    // 旧 → 移行してから出力
    const v2 = (raw as any).schema === 2 ? (raw as DatasetDataV2) : migrateLegacy(raw as DatasetDataLegacy);

    const url = v2.videoId ? `https://www.youtube.com/watch?v=${v2.videoId}` : "";
    const lines: string[] = [];
    lines.push(url);
    lines.push("秒数,見出し語,習熟度");
    v2.words.forEach((w) => {
      lines.push(`${w.t},${w.word || ""},${w.level}`);
    });
    const csvText = lines.join("\n");
    const filename = `${v2.title || "dataset"}-${v2.id}.csv`;
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
    const urlObj = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = urlObj;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(urlObj);
  };

  /** 削除 */
  const removeDataset = (id: string, title: string) => {
    if (!confirm(`「${title}」を本当に削除しますか？`)) return;
    const next = datasetList.filter((m) => m.id !== id);
    setDatasetList(next);
    saveIndex(next);
    deleteDataset(id);
    if (activeId === id) {
      setActiveId(null);
      setVideoId("");
      setWords([]);
      setTopMode("select");
    }
  };

  /** 進捗の永続化（activeId の words を都度保存） */
  useEffect(() => {
    if (!activeId) return;
    const raw = loadDatasetAny(activeId);
    if (!raw) return;
    const v2 = (raw as any).schema === 2 ? (raw as DatasetDataV2) : migrateLegacy(raw as DatasetDataLegacy);
    v2.words = words;
    v2.windowSec = windowSec;
    saveDataset(v2);
  }, [activeId, words, windowSec]);

  /** 表示リスト（トグル適用） */
  const visibleSegments = useMemo(
    () => (unknownOnly ? segments.filter((s) => s.level === 0) : segments),
    [segments, unknownOnly]
  );

  /** 可視リスト上の index から連続再生（各区間1回） */
  const playSequenceFrom = (index: number) => {
    if (!playerRef.current || index < 0 || index >= visibleSegments.length)
      return;
    const seg = visibleSegments[index];
    try { playerRef.current.setPlaybackRate(1); } catch {}
    currentRef.current = { idx: index };
    playerRef.current.seekTo(seg.start, true);
    playerRef.current.playVideo();
    clearInterval(pollingRef.current);
    const END_EPS = 0.01; // 浮動小数誤差逃げ
    pollingRef.current = setInterval(() => {
      const cur = currentRef.current;
      if (!cur) return;
      const t = playerRef.current?.getCurrentTime?.() ?? 0;
      if (t >= seg.end - END_EPS) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
        // 各区間1回のみ → 次へ
        playSequenceFrom(index + 1);
      }
    }, 120);
  };

  /** 既知トグル（WordRow を直接更新） */
  const toggleKnownByStart = (start: number) => {
    setWords((prev) =>
      prev.map((w) =>
        w.t === start ? { ...w, level: w.level ? 0 : 1 } : w
      )
    );
  };

  const knownCount = useMemo(
    () => words.reduce((acc, w) => acc + (w.level ? 1 : 0), 0),
    [words]
  );

  /** UI */
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="max-w-screen-sm mx-auto px-4 pb-28">

        {/* 最上部：16:9エリア（select / help / video） */}
        <div
          className="w-full rounded-2xl overflow-hidden border bg-black/5 mt-3"
          style={{ aspectRatio: "16 / 9" }}
        >
          {topMode === "select" && (
            <div className="h-full w-full flex flex-col">
              {/* Toolbar */}
              <div className="p-3 flex items-center justify-between">
                <div className="text-sm font-medium">ローカルの学習データ</div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setTopMode("help")}
                    className="w-10 h-10 rounded-full border bg-white flex items-center justify-center"
                    title="ヘルプ"
                  >
                    <span className="material-symbols-outlined">help</span>
                  </button>
                  <input
                    ref={csvFileInput}
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={handleUpload}
                  />
                  <button
                    onClick={onUploadClicked}
                    className="w-10 h-10 rounded-full border bg-white flex items-center justify-center"
                    title="アップロード"
                  >
                    <span className="material-symbols-outlined">upload</span>
                  </button>
                </div>
              </div>

              {/* List */}
              <div className="flex-1 overflow-auto px-3 pb-3">
                {datasetList.length === 0 ? (
                  <div className="h-full w-full flex items-center justify-center text-sm text-gray-500">
                    まだ学習データがありません。右上の{" "}
                    <span className="material-symbols-outlined mx-1">upload</span>{" "}
                    からCSVを追加してください。
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {datasetList.map((meta) => (
                      <li
                        key={meta.id}
                        className="bg-white border rounded-xl px-3 py-2 flex items-center justify-between"
                      >
                        {/* 行の非ボタン部分をクリックで確認→開始 */}
                        <div
                          className="min-w-0 pr-2 flex-1 cursor-pointer"
                          onClick={() => {
                            if (confirm(`「${meta.title}」の学習を開始しますか？`)) {
                              startLearning(meta.id);
                            }
                          }}
                        >
                          <div
                            className="text-sm font-medium truncate"
                            title={meta.title || "NoName"}
                          >
                            {meta.title || "NoName"}
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          {/* ダウンロード */}
                          <button
                            className="w-9 h-9 rounded-full border bg-white flex items-center justify-center"
                            title="ダウンロード"
                            onClick={(e) => {
                              e.stopPropagation();
                              downloadCSV(meta.id);
                            }}
                          >
                            <span className="material-symbols-outlined">
                              download
                            </span>
                          </button>

                          {/* 削除 */}
                          <button
                            className="w-9 h-9 rounded-full border bg-white flex items-center justify-center"
                            title="削除"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeDataset(meta.id, meta.title || "NoName");
                            }}
                          >
                            <span className="material-symbols-outlined">
                              delete
                            </span>
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {topMode === "help" && (
            <div className="h-full w-full bg-white flex flex-col">
              <div className="px-3 py-2 flex items-center justify-between border-b">
                <div className="text-sm font-semibold">ヘルプ</div>
                <button
                  className="text-sm underline"
                  onClick={() => setTopMode("select")}
                >
                  戻る
                </button>
              </div>
              <div className="p-3 text-sm leading-relaxed overflow-auto">
                <p className="mb-2">
                  このサイトは、YouTubeの読み上げ教材などから
                  <span className="font-semibold">苦手な単語だけ</span>
                  を抽出して繰り返し再生するためのツールです。
                </p>
                <ul className="list-disc pl-5 space-y-1 mb-3">
                  <li>画面右上の <span className="material-symbols-outlined align-middle text-base">upload</span> からCSVをアップロードします。</li>
                  <li>1行目に動画URL/ID、2行目にヘッダ（例：<code>秒数,見出し語,習熟度</code>）、3行目以降にデータを記述。</li>
                  <li>見出し語は空でもOK。習熟度は空白=0(未習)／1(既知)。</li>
                  <li>アップ後、一覧の行をタップ → 確認で学習開始。</li>
                  <li>学習画面下の一覧で単語名をタップすると、その位置から<strong>自動で次へ</strong>進みます（各区間は1回ずつ）。</li>
                  <li>上部トグルで「<strong>すべて/未習のみ</strong>」を切替できます（表示と再生の対象に反映）。</li>
                  <li>「知ってる」ボタンで既知⇄未知を切替できます。</li>
                  <li>保存はブラウザのローカルストレージを利用します。</li>
                </ul>
                <p className="text-xs text-gray-500">
                  ※ 広告や埋め込み不可設定の動画では制御が中断される場合があります。第三者のコンテンツを利用する際は権利・利用規約にご注意ください。
                </p>
              </div>
            </div>
          )}

          {topMode === "video" && (
            <div ref={iframeWrap} className="w-full h-full" />
          )}
        </div>

        {/* 学習時の操作群（videoモードのみ表示） */}
        {topMode === "video" && (
          <>
            {/* トグル（すべて/未習のみ） */}
            <div className="mt-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600">表示・再生対象</span>
                <button
                  className="rounded-full border px-3 py-1 text-sm bg-white"
                  onClick={() => setUnknownOnly(!unknownOnly)}
                  title="すべて⇔未習のみ"
                >
                  {unknownOnly ? "未習のみ" : "すべて"}
                </button>
              </div>
            </div>

            {/* Words list → 2列（左=単語名 / 右=知ってる） */}
            <div className="mt-6">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm text-gray-600">
                  表示 {visibleSegments.length} ／ 総単語 {segments.length} ／ 既知 {knownCount}
                </div>
              </div>

              <div className="border rounded-xl overflow-hidden">
                {/* header row */}
                <div className="grid grid-cols-[1fr_auto] gap-2 bg-gray-50 px-3 py-2 text-xs text-gray-500">
                  <div className="text-left">単語名（タップでこの位置から連続再生）</div>
                  <div className="text-right">知ってる</div>
                </div>

                <div className="max-h-80 overflow-auto divide-y">
                  {visibleSegments.map((seg, idx) => {
                    const known = seg.level === 1;
                    return (
                      <div
                        key={`${seg.start}:${idx}`}
                        className="grid grid-cols-[1fr_auto] items-center gap-2 px-3 py-2"
                      >
                        <button
                          className="text-left text-sm truncate"
                          onClick={() => playSequenceFrom(idx)}
                          title="この位置から自動で次へ進みます"
                        >
                          {seg.word || ""}
                        </button>
                        <button
                          className={`w-9 h-9 rounded-full border flex items-center justify-center ${
                            known ? "bg-gray-100" : "bg-amber-100"
                          }`}
                          onClick={() => toggleKnownByStart(seg.start)}
                          title={known ? "未知に戻す" : "知ってるにする"}
                        >
                          <span className="material-symbols-outlined text-[18px]">
                            {known ? "task_alt" : "radio_button_unchecked"}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                  {visibleSegments.length === 0 && (
                    <div className="px-3 py-4 text-sm text-gray-500">
                      対象の項目がありません（トグルや既知状態を確認してください）。
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

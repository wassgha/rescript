# Rescript 汉化与原语种转录：手术刀式实施计划

> 审计基线：2026-08-09；`jiezhengj/rescript` 与上游 `wassgha/rescript` 的 `main` 均指向 `d43e2d6afb8e4d2e82dc5d2b04e248f0435fc676`（Release v1.1.7）。
>
> 本文只规划实现，不包含功能代码改动。目标是尽量沿用现有结构，以小而独立、容易复核和回退的补丁完成简体中文界面、界面语言自动识别/切换，以及中文音频保持中文转录。
>
> 实施勘误（2026-08-09）：真实 Windows 验收发现项目固定的 Transformers.js 4.2 在省略 `language` 时会明确回退英语，其源码仍标注 `TODO: Implement language detection`。最终实现因此增加 Whisper 标准的首 token 语言探测，再以探测到的语言和 `task: "transcribe"` 正式解码；下文相关步骤已按验证后的方案修订。

## 1. 结论先行

当前的两个问题来源不同，不能共用一个“语言”设置：

1. **界面一直是英文**：项目没有 i18n 层，React 文案、无障碍文案、运行进度、错误消息、Electron 原生菜单和更新对话框均直接写死为英文；`app/layout.tsx` 与 `app/global-error.tsx` 也固定使用 `lang="en"`。
2. **中文音频得到英文文本**：项目实际上已经支持 `en/es/fr/de/zh` 五种转录语言，但默认值是 `en`。该值从 Zustand store 经 `useTranscriber` 发送给 Worker，最终作为 Whisper 的 `language: "en"` 解码约束。代码没有显式设置 `task: "translate"`，因此这不是一条明确的“翻译为英文”流水线，而是**默认英语解码约束造成了类似翻译的结果**。

最小修复路线是：

- 新增一层轻量、项目内置、只有 `en` 与 `zh-CN` 的界面本地化，不引入第三方 i18n 依赖；
- 界面语言默认 `system`，根据浏览器/Electron 的系统语言识别，可手动切换并持久化；
- 保留现有转录语言结构，新增 `auto` 偏好并改为新安装的默认值；
- Whisper 始终显式传 `task: "transcribe"`；`auto` 时先把首 token 限制在模型的语言 token 集合中完成探测，再把结果（如 `zh`）传给正式解码；手动选中文时直接传 `language: "zh"`；
- 自动语种模式不猜测 CTC 对齐模型，先使用现有 Whisper 词时间戳 + VAD/包络校正；手动选中文时继续使用项目已有的中文 XLS-R 对齐器；
- 不增加“任意目标语言翻译”能力。Whisper 的“转录原文”和“翻译为英文”是不同任务，本需求只启用前者。

## 2. 当前项目事实与根因

### 2.1 技术与部署形态

- Web/界面：Next.js 16 App Router、React 19、TypeScript、Tailwind。
- 桌面端：同一套静态导出由 Electron 42 承载，目标为 macOS、Windows、Linux。
- 状态：Zustand；项目和媒体保存在 IndexedDB；偏好保存在 localStorage。
- 转录：Web Worker 内运行 `@huggingface/transformers@4.2.0`，Whisper Base/Small；另有 Parakeet v3。
- 后处理：VAD、语言相关 CTC 强制对齐、说话人分离；均在本机运行。
- Fork 状态：当前 fork 未包含自定义提交，与上游完全同步，适合从小型独立提交开始维护。

### 2.2 已经存在、应当复用的转录语言能力

当前代码已经具备以下基础，不应另起炉灶：

- `lib/languages.ts`
  - `TranscriptLanguage = "en" | "es" | "fr" | "de" | "zh"`；
  - 语言标签、原生名称、旗帜、短代码；
  - localStorage 键 `rescript.transcript-language`；
  - 当前默认值 `DEFAULT_TRANSCRIPT_LANGUAGE = "en"`。
- `components/ModelSelector.tsx`
  - 模型菜单内已有转录语言子菜单；
  - 非英语时会在 Whisper 模型按钮上显示语言短代码。
- `lib/store.ts`、`lib/autosave.ts`、`lib/projects.ts`
  - 转录语言已进入 store、项目保存和恢复流程。
- `hooks/useTranscriber.ts`、`lib/types.ts`
  - 语言随 `WorkerRequest` 发给转录 Worker。
- `workers/transcription.worker.ts`
  - Whisper 调用会传 `language: transcriptLanguage`；
  - Parakeet 本身自动识别语言，但当前设置仍会影响后续对齐器选择。
- `lib/alignModels.ts`
  - 中文已经映射到 `onnx-community/wav2vec2-large-xlsr-53-chinese-zh-cn-ONNX`；
  - 中文文字的 CTC 归一化模式已是 `cjk`。

因此，本项目不缺“中文模型支持”，缺的是**正确的默认语义、明确的转录任务，以及更易发现的设置入口**。

### 2.3 中文变英文的具体数据流

```text
lib/languages.ts
  DEFAULT_TRANSCRIPT_LANGUAGE = "en"
          ↓
lib/store.ts
  transcriptLanguage: "en"
          ↓
hooks/useTranscriber.ts
  postMessage({ ..., language: "en" })
          ↓
workers/transcription.worker.ts
  const transcriptLanguage = language ?? "en"
  transcriber(audio, { ..., language: transcriptLanguage })
          ↓
Whisper 解码被约束为英语 token，中文语音表现为英文输出
```

当前 Worker 没有写 `task: "translate"`，但也没有写 `task: "transcribe"`。实施时应显式写出后者，避免模型配置或依赖升级改变默认行为。Hugging Face 的 Whisper 接口把 `task` 定义为 `transcribe` 或 `translate`，并把 `language` 定义为生成所用的语言 token；参见 [Whisper 官方文档](https://huggingface.co/docs/transformers/en/model_doc/whisper)。

### 2.4 界面英文的分布

用户可见英文不是只在组件文本节点里，还分布在以下边界：

| 边界 | 当前位置 | 示例 |
| --- | --- | --- |
| 页面与主要组件 | `app/*.tsx`、`components/*.tsx` | Settings、Export、Tools、Speaker、Browse |
| 无障碍/提示文字 | 多个组件的 `aria-label`、`title`、`placeholder` | Join clips、Zoom in、Search or create |
| 进度消息 | `Editor`、`useTranscriber`、Worker | Detecting speech、Transcribing、Aligning words |
| 可恢复错误 | `lib/ffmpeg.ts`、`lib/parseTranscript.ts`、`lib/store.ts` 等 | Could not extract audio、No words to export |
| 相对日期 | `lib/projects.ts` | just now、3h ago |
| 模型说明 | `lib/models.ts` | Faster download and transcription |
| Electron 原生菜单 | `electron/menu.ts` | File、Open Project、Recent Projects |
| 更新对话框 | `electron/updater.ts` | Update available、Restart、Later |
| 根错误页 | `app/global-error.tsx` | Something went wrong、Try again |
| HTML 语言/元数据 | `app/layout.tsx` | `lang="en"`、英文 title/description |

控制台日志、Sentry stage、telemetry 事件名、内部异常诊断不属于界面文案，不应为了汉化而改名。

## 3. 范围与非目标

### 3.1 本次必须完成

- 界面支持 English 与简体中文。
- 默认跟随系统/浏览器语言；所有中文区域代码统一解析为 `zh-CN`，其他语言回退到 `en`。
- 设置中可选：跟随系统、English、简体中文。
- 手动选择持久化；选择“跟随系统”时响应浏览器 `languagechange`。
- Web、macOS、Windows、Linux 的应用内界面使用同一有效语言。
- Electron 菜单、自定义更新对话框与渲染器同步切换。
- 转录语言支持“自动检测”，并将其设为未设置偏好时的默认值。
- Whisper 始终执行原语种转录；中文音频在自动模式或手动中文模式下输出中文。
- 用户仍可手动指定 `en/es/fr/de/zh`，用于短音频或自动识别不稳定时纠正模型。
- 设置、项目保存和旧数据读取向后兼容。
- 不新增运行时网络请求，不破坏离线模式。

### 3.2 明确不做

- 不把中文音频翻译为任意目标语言；不新增机器翻译模型。
- 不翻译用户导入的 SRT/VTT/JSON 内容，只翻译应用 UI。
- 不翻译品牌名、模型名、文件格式、快捷键和技术缩写，如 Rescript、Whisper、Parakeet、MP4、SRT、WebGPU。
- 首期不做繁体中文词库；系统为 `zh-TW`/`zh-HK` 时暂时使用简体中文，并在设置中明确写“简体中文”。
- 不重构编辑器、时间轴、导出、对齐或 IndexedDB 架构。
- 不引入 `next-intl`、`react-i18next` 等依赖；当前只有两种 UI 语言且应用是 client-only，第三方框架收益不足以抵消改动面。
- 不把 README、发行说明和官网营销内容纳入应用运行时汉化；可在功能稳定后另开文档 PR。

## 4. 设计原则

1. **两个语言域完全分离**
   - `uiLocale`：应用按钮、菜单、提示所使用的语言。
   - `transcriptLanguagePreference`：音频转录语言提示，和 UI 语言无关。
   - 中文界面不能自动把所有音频强制设为中文；英文界面也不能强制英文转录。
2. **有效语言在边界解析一次**
   - UI 使用 `system | en | zh-CN` 偏好，解析为有效 `en | zh-CN`。
   - 转录使用 `auto | en | es | fr | de | zh` 偏好；发送 Worker 前将 `auto` 解析为“无人工语言提示”，由 Worker 对音频执行模型原生首 token 探测。
3. **传 key，不传英文句子**
   - 进度和可预期错误尽量使用稳定 key/code；在渲染器按当前 UI 语言翻译。
   - 控制台诊断仍保留英文，便于与上游和 Sentry 搜索结果一致。
4. **不把翻译字典塞进编辑 store**
   - UI locale 是安装偏好，不是媒体项目状态；用独立 Context/Hook 管理，避免污染现有编辑 undo/autosave 逻辑。
5. **翻译 diff 与行为 diff 分开提交**
   - 先修转录语义并测试；再加 i18n 基础设施；最后批量替换 UI 文案和桌面壳文案。

## 5. 界面本地化方案

### 5.1 最小数据模型

新增纯 TypeScript 类型与解析函数：

```ts
export type UiLocale = "en" | "zh-CN";
export type UiLocalePreference = "system" | UiLocale;

export const DEFAULT_UI_LOCALE_PREFERENCE: UiLocalePreference = "system";

export function resolveUiLocale(
  preference: UiLocalePreference,
  systemLanguages: readonly string[]
): UiLocale;
```

解析规则：

- 手动 `en`/`zh-CN` 直接使用；
- `system` 时按 `navigator.languages` 的优先顺序寻找已支持语言：先遇到 `zh-*` 就解析为 `zh-CN`，先遇到 `en-*` 就解析为 `en`，不支持的语言继续向后查找；
- 没有任何已支持语言时回退 `en`；
- Electron 初次创建菜单时用 `app.getLocale()` 做同样解析；渲染器加载后再通过 IPC 发送最终有效语言，确保手动偏好覆盖系统值。

偏好键建议为 `rescript.ui-locale`，只存 `system | en | zh-CN`，不要存解析后的系统语言。这样系统语言变化后，“跟随系统”仍然有效。

### 5.2 轻量字典与 API

新增 `lib/i18n.ts`，使用扁平 key，避免引入运行时依赖：

```ts
const en = {
  "settings.title": "Settings",
  "settings.language": "Interface language",
  "transcription.language.auto": "Auto-detect",
  "progress.transcribing": "Transcribing…",
  "export.downloadFile": "Download {name}",
} as const;

const zhCN: Record<keyof typeof en, string> = {
  "settings.title": "设置",
  "settings.language": "界面语言",
  "transcription.language.auto": "自动检测",
  "progress.transcribing": "正在转录…",
  "export.downloadFile": "下载 {name}",
};
```

要求：

- 以英文 key 集合约束中文词条完整性，缺 key 在 TypeScript 编译期失败；
- `t(key, params?)` 仅做简单命名插值，不引入 ICU 解析器；
- 数字、日期、相对时间使用 `Intl.NumberFormat`、`Intl.DateTimeFormat`、`Intl.RelativeTimeFormat`，避免拼接 `3h ago`；
- 未知 key 在开发环境抛错或 console.error，生产环境回退英文；
- 文案函数可在 React 之外调用，但不直接读取 Zustand。

建议新增 `components/I18nProvider.tsx`：

- lazy initializer 从 localStorage + `navigator.languages` 得到首屏语言，避免先渲染英文再闪成中文；
- 提供 `{ locale, preference, setPreference, t }`；
- 监听 `storage`，同步同源多个标签页；
- preference 为 `system` 时监听 `languagechange`；
- 更新 `document.documentElement.lang` 与 `document.title`；
- 调用 `window.rescriptDesktop?.setUiLocale(locale)` 同步 Electron 主进程。

`app/page.tsx` 在动态 `Editor` 外包一层 Provider。Provider 本身仍是 client component，不改变当前 client-only 编辑器架构。

### 5.3 设置界面

在 `components/SettingsMenu.tsx` 新增两个清晰分区：

1. **界面语言 / Interface language**
   - 跟随系统 / System
   - English
   - 简体中文
2. **转录语言 / Transcript language**
   - 自动检测 / Auto-detect（推荐）
   - English、Español、Français、Deutsch、中文
   - 辅助说明：“自动检测会保留音频的原语言；识别不准时可手动指定。”

模型菜单中现有 `LanguageSection` 保留，因为用户通常在导入媒体前决定转录语言。将选项列表抽成一个小型可复用组件/数据源，设置菜单和模型菜单共享，不复制状态或语言数组。

模型按钮在自动模式显示 `AUTO`，不要像当前英语默认值一样完全隐藏。这样用户能立即看出应用不会强制英语。

Parakeet v3 的能力要诚实呈现：

- Parakeet ASR 后端自身自动识别语种，现有 `parakeet.js` 调用不接受语言参数；
- 手动语言只能作为后续对齐器提示，不能承诺控制 Parakeet 输出；
- 在 Parakeet 被选中时显示“自动识别；手动语言仅用于词对齐”的短说明，或禁用强制语言入口；
- 中文“确保原文输出”的验收以 Whisper Base/Small 为准。

### 5.4 HTML、字体与根错误页

- `app/layout.tsx`
  - 保留 Next 静态 metadata 的英文基线；运行时由 Provider 更新 title；
  - `<html lang>` 的初始值仍可为 `en`，但在交互前脚本中只设置 lang，不渲染文案；
  - 不需要下载中文 WebFont。Geist 只包含 Latin，中文交给现有 system-ui 回退，可减少包体和字体闪动。
- `app/global-error.tsx`
  - 该组件替换 RootLayout，不能依赖 Provider；直接调用纯 `load/resolve/t` 函数生成中英文错误页；
  - 同步设置正确的 `<html lang>`。

### 5.5 文案覆盖规则

首期必须覆盖所有用户能看到或屏幕阅读器能读到的文字：

- 可见按钮、标题、说明、空状态；
- `aria-label`、`title`、`placeholder`、图片 `alt`；
- `alert`、`confirm`、对话框；
- 进度、网络错误、导入/导出错误；
- 模型说明、最近项目相对日期；
- Electron 菜单、更新对话框。

不翻译：

- `console.warn/error` 诊断文字；
- Sentry stage 名、telemetry event/property；
- 程序员断言，例如“Popover components must be used…”；
- 文件扩展名、模型 ID、品牌名。

建议术语表：

| English | 简体中文 | 说明 |
| --- | --- | --- |
| Transcript | 转录文本 | 指最终文字内容 |
| Transcription | 转录 | 指处理过程 |
| Transcript language | 转录语言 | 不写“翻译语言”，避免能力误导 |
| Speaker | 说话人 | 与说话人分离术语一致 |
| Cut | 剪除 | 时间轴移除内容的动作 |
| Delete | 删除 | 删除所选词/片段 |
| Restore | 恢复 | 还原已删除内容 |
| Split | 分割 | 创建片段边界 |
| Join clips | 合并片段 | 移除分割点 |
| Filler words | 语气词 | 包括“嗯、呃、…” |
| Export | 导出 | 生成媒体或文稿 |
| Start over | 重新开始 | 回到导入页 |

### 5.6 Electron 与各操作系统

新增 `electron/locale.ts`，仅负责桌面主进程的有效 locale 和桌面文案。它不依赖 React，也不读取 renderer localStorage。

IPC 最小扩展：

- `types/rescript-desktop.d.ts`：增加 `setUiLocale(locale: "en" | "zh-CN")`；
- `electron/preload.ts`：发送 `ui:set-locale`；
- `electron/main.ts`：严格校验值，更新主进程 locale，并重建应用菜单；
- `electron/menu.ts`：菜单模板从 locale 取标签，保留现有 role、accelerator、command，不改行为；
- `electron/updater.ts`：更新完成时从主进程 locale 取 Restart/Later/title/message/detail。

原生菜单需要覆盖手写的 File 项，也应给 Electron role 项显式提供中英文 label，保证“手动切换中文”在英文操作系统上同样生效。role 本身不变，快捷键与系统行为不变。

Windows 安装器可作为同一批次的低风险配置补充：在 `package.json` 的 `nsis` 下只加入 English 与 Simplified Chinese 的 installer language，并启用多语言安装器；macOS 系统对话框、文件选择器和 Linux 桌面环境对话框由操作系统本地化，不应由应用伪造。需要以当前 electron-builder 版本的官方配置名为准后再提交，避免凭旧版配置猜测。

## 6. 转录原语种方案

### 6.1 类型拆分，但保留现有命名和文件

不要把 `auto` 当成真实语种传给模型或对齐器。建议在 `lib/languages.ts` 增加：

```ts
export type TranscriptLanguage = "en" | "es" | "fr" | "de" | "zh";
export type TranscriptLanguagePreference = "auto" | TranscriptLanguage;

export const DEFAULT_TRANSCRIPT_LANGUAGE_PREFERENCE = "auto";
```

为减少连锁改名：

- Zustand 字段可继续叫 `transcriptLanguage`，但类型改为 `TranscriptLanguagePreference`；
- WorkerRequest 的 `language` 改为可选的具体 `TranscriptLanguage`，绝不接收字符串 `auto`；
- `useTranscriber` 是偏好值到 Worker 参数的唯一转换边界。

### 6.2 持久化兼容

沿用 localStorage 键 `rescript.transcript-language`：

- 没有旧值：返回新的默认 `auto`；
- 旧值为 `en/es/fr/de/zh`：视为用户明确选择，原样保留；
- 新值 `auto`：正常读取；
- 非法值：回退 `auto`。

不升级 IndexedDB `DB_VERSION`：字段不是索引，记录是结构化克隆对象，允许直接保存新字符串。旧项目的具体语言值仍合法；缺字段时回退 `auto`。旧项目打开时本来就跳过重新转录，因此不会改变其已有文字。

这个迁移策略能修复绝大多数“从未手动选语言”的用户，同时不会把明确选择英语的用户悄悄改成自动。

### 6.3 Worker 调用的唯一行为改动

在 `hooks/useTranscriber.ts`：

```ts
const preference = store.transcriptLanguage;
const language = preference === "auto" ? undefined : preference;
```

构造消息时，`auto` 必须**省略** `language` 属性，而不是传 `"auto"` 或 `undefined` 字符串。

在 `workers/transcription.worker.ts`：

```ts
const detectedLanguage = transcriptLanguage ?? await detectWhisperLanguage(
  transcriber,
  longestSpeechProbe
);

const asrOptions = {
  chunk_length_s: 29,
  stride_length_s: 5,
  return_timestamps: "word",
  no_repeat_ngram_size: 4,
  repetition_penalty: 1.05,
  task: "transcribe",
  language: detectedLanguage,
};
```

必须删除 Worker 中的 `language ?? "en"`。关键语义：

- 自动：先以 `<|startoftranscript|>` 为前缀，只允许模型生成语言 token，取得 `zh/en/...`；再以 `task=transcribe, language=<detected>` 输出原语言；
- 中文：`task=transcribe, language=zh`，明确输出中文转录；
- 英语：`task=transcribe, language=en`；
- 代码中永远不使用 `task=translate`。

语言选项提取为 `lib/transcriptionOptions.ts` 的纯函数，使测试能直接断言“自动探测出的任意 Whisper 语言代码都继续使用 transcribe、任何模式都不是 translate”。真正的模型探测另由安装客户端端到端测试覆盖。

### 6.4 自动模式与强制对齐

当前 `transcriptLanguage` 同时用于 Whisper 解码和 CTC 对齐模型选择。自动探测虽然能给出可靠语种，但该结果只存在于 Worker 单次任务中；为避免扩大项目持久化和下载行为，自动模式仍不默认套用语言专用 CTC 对齐器。

首期采用最小、安全降级：

- `runWhisper`、`runParakeet`、`refineWordTimestamps`、`forceAlign` 的 language 参数允许缺省；
- 自动模式不预热/下载任何语言专用 CTC 对齐器；
- 自动模式继续运行已有的：
  1. Whisper/Parakeet 原始词时间戳；
  2. `alignWordsToSpeech` 的 VAD/响度包络校正；
  3. 语气词占位插入；
  4. 说话人分离；
- 手动 `zh` 仍预热并运行现有中文 XLS-R CTC 对齐器；其他手动语言行为保持不变。

这种取舍比“从输出字符猜语种后下载对齐器”更可靠。仅凭拉丁文字很难区分英语、西班牙语、法语和德语；猜错对齐模型可能比不做 CTC 更坏。若后续确实需要“自动识别后仍强制对齐”，可把本次已经验证的 Whisper 首 token 探测结果显式纳入项目记录与对齐器生命周期，但那属于独立的下载/持久化行为扩展。

### 6.5 进度和错误的本地化边界

Worker 不能使用 React Context。不要把当前 UI locale 固化进一个长时间运行的 Worker；否则用户在转录中切换语言时，后续消息仍是旧语言。

建议把 Worker 的进度改为稳定 stage：

```ts
type ProgressStage =
  | "loadingSpeechModel"
  | "detectingSpeech"
  | "transcribing"
  | "loadingAlignerFromCache"
  | "downloadingAligner"
  | "aligningWords"
  | "identifyingSpeakers"
  | "gpuFallback";

type WorkerResponse =
  | { type: "progress"; stage: ProgressStage; value: number | null }
  | ...;
```

`useTranscriber` 将 stage 存入 store，显示组件用当前 `t()` 翻译。对于网络/模型等可预期错误，增加少量 error code；未知异常仍携带英文 fallback 并上报 Sentry。这样既能即时切换语言，又不翻译开发诊断。

如果必须进一步压缩首个 PR，可先只把进度 stage 化，把罕见底层错误保留英文；但验收前必须覆盖普通用户能触发的导入、网络、媒体、导出错误。

## 7. 精确文件改动清单

### 7.1 新增文件（建议 4 个）

| 文件 | 作用 |
| --- | --- |
| `lib/i18n.ts` | UI locale 类型、解析、存取、字典、插值和 Intl helpers |
| `components/I18nProvider.tsx` | React locale 状态、事件监听、html/title/IPC 同步、`useI18n` |
| `lib/transcriptionOptions.ts` | 从转录语言偏好生成可测试的 Whisper `{ task, language? }` |
| `electron/locale.ts` | Electron 主进程 locale、菜单/更新对话框文案 |

如单个 `lib/i18n.ts` 超过约 400 行，再拆为 `lib/i18n/{core,messages}.ts`；不要一开始为两个 locale 建复杂目录层级。

### 7.2 转录行为改动（核心、小范围）

| 文件 | 精确改动 |
| --- | --- |
| `lib/languages.ts` | 增加 preference/auto；默认改 auto；持久化校验兼容旧值；增加 Auto 显示信息 |
| `lib/types.ts` | WorkerRequest 的 language 变为可选具体语种；Progress 使用 stage |
| `lib/store.ts` | store 字段类型接受 auto；reset/hydrate 默认 auto；进度状态接受 stage |
| `hooks/useTranscriber.ts` | auto → 省略 language；使用纯 options helper；进度按 stage 保存 |
| `workers/transcription.worker.ts` | 删除英语 fallback；auto 用 Whisper 首 token 探测实际语种；正式解码显式 `task: "transcribe"` 和探测/手动 language；auto 跳过语言专用 aligner |
| `lib/projects.ts` | 项目字段接受 preference；缺失/非法值回退 auto；不升级 DB |
| `lib/autosave.ts` | 无结构改动，仅类型随 store 变化；确认仍保存 preference |
| `components/ModelSelector.tsx` | 增加 Auto；trigger 显示 AUTO；复用语言选择 UI；说明 Parakeet 限制 |
| `components/SettingsMenu.tsx` | 增加转录语言设置入口和简短解释 |

`lib/alignModels.ts` 已经能对 `undefined` 返回 null，原则上只需类型/注释微调，不应重写映射。

### 7.3 React UI 汉化

必须逐文件只替换用户可见字符串，不做顺手重构：

| 文件 | 主要文案范围 |
| --- | --- |
| `app/layout.tsx` | lang boot、运行时标题基线 |
| `app/global-error.tsx` | 崩溃标题、说明、重试按钮、lang |
| `app/page.tsx` | 挂载 I18nProvider；loading 的 aria 文案（如补充） |
| `components/UploadScreen.tsx` | 拖放/浏览、准备状态、隔离错误、最近项目、三步说明、alerts |
| `components/SettingsMenu.tsx` | 设置、外观、隐私、链接、新增的两种语言设置 |
| `components/ModelSelector.tsx` | 模型/来源/语言菜单、aria、模型说明 |
| `components/Editor.tsx` | 导入提醒、媒体错误、进度、Undo/Redo/Export |
| `components/TopBar.tsx` | 重新开始及提示 |
| `components/TranscriptPanel.tsx` | 导入、显示删除词、纠正、分割提示、跟随播放头 |
| `components/TranscriptToolsMenu.tsx` | 工具、语气词/静音批处理、title/aria |
| `components/SpeakerLabel.tsx` | 说话人命名、搜索、新建、移动、菜单 |
| `components/Timeline.tsx` | 播放、前后跳、分割/删除/恢复、缩放、修剪、合并提示 |
| `components/ExportDialog.tsx` | tabs、格式/分辨率、说明、渲染进度、下载/重试、错误 |
| `components/ImportTranscriptOption.tsx` | 导入状态、错误和文件选择说明 |
| `components/DesktopAppBanner.tsx` | 桌面端推荐、平台下载、关闭 |
| `components/SocialLinks.tsx` | 无障碍标签；品牌名不翻译 |
| `components/LogoLoader.tsx` | Loading aria |

`components/Popover.tsx` 内用于程序员的 context 错误不翻译。

### 7.4 非组件用户文案

| 文件 | 处理方式 |
| --- | --- |
| `lib/models.ts` | label 保留模型名；description 改为翻译 key 或由 UI 映射 |
| `lib/projects.ts` | `formatRelativeTime` 接收 locale，改用 Intl.RelativeTimeFormat |
| `lib/ffmpeg.ts` | 用户可恢复错误改为 error code；内部诊断不改 |
| `lib/parseTranscript.ts` | 空文件、格式错误等改为 error code |
| `lib/serializeTranscript.ts` | 无内容可导出等改为 error code |
| `hooks/useDesktopMenu.ts` | confirm/alert 本地化；console 保留英文 |
| `electron/menu.ts` | 本地化所有菜单 label，不改 role/accelerator/command |
| `electron/updater.ts` | 本地化更新对话框，不改 updater 流程 |
| `electron/preload.ts` | 增加 locale IPC 方法 |
| `electron/main.ts` | 校验 locale、同步菜单/更新器 |
| `types/rescript-desktop.d.ts` | 补充 bridge 类型 |
| `package.json` | 可选：Windows NSIS 英/简中语言；不新增 npm 依赖 |

## 8. 实施顺序与提交拆分

### 阶段 A：先固定转录行为

1. 为转录偏好增加 `auto`，未设置用户默认 auto。
2. 新增纯 `transcriptionOptions` helper。
3. Worker 在 auto 时先执行 Whisper 语言 token 探测，再以探测语言和显式 `task: "transcribe"` 正式解码。
4. auto 跳过 CTC；手动语言保持现有对齐路径。
5. 更新项目持久化校验与语言单元测试。

建议提交：`fix(transcription): preserve detected source language`

这一提交只解决“中文变英文”，即使后续汉化需要返工，也能独立合并和回退。

### 阶段 B：加入轻量 i18n 核心和设置

1. 新增 `lib/i18n.ts` 与 key 完整性测试。
2. 新增 Provider/Hook，默认 system，支持 persistence、storage、languagechange。
3. 在 Settings 增加界面语言与转录语言入口。
4. 更新 html lang 和根错误页。

建议提交：`feat(i18n): add system-aware English and Simplified Chinese locales`

### 阶段 C：逐表面替换 React 用户文案

按页面分 2～3 个提交，避免一个超大 diff：

1. 上传页、设置、模型选择；
2. 编辑器、转录、说话人、时间轴；
3. 导出、错误、无障碍文案。

每个提交只做 `string → t(key)`，不调样式、不改业务逻辑。中文长度引起的布局修正单独提交，便于审查。

### 阶段 D：桌面壳与跨平台收口

1. 新增主进程 locale 模块和 IPC。
2. 本地化菜单与 updater 对话框。
3. 如官方配置验证通过，再加入 Windows 双语安装器。
4. 在 macOS/Windows/Linux 打包产物中人工验证。

建议提交：`feat(electron): localize native menus and update dialog`

### 阶段 E：测试、文档和发布

1. 执行完整 lint/typecheck/build。
2. 运行纯函数测试与真实中文音频验收。
3. 在 README 增加简短的 Language 行为说明；详细中文 README 可另做。
4. 先发布 prerelease，验证自动更新和不同系统 locale，再发布正式版。

## 9. 测试计划

### 9.1 自动化测试

新增/扩展：

- `tests/i18n-test.ts`
  - `zh`、`zh-CN`、`zh-Hans`、`zh-HK` → `zh-CN`；
  - `en-US`、`fr-FR`、空数组 → `en`；
  - 手动 preference 覆盖系统语言；
  - 英中 key 完整一致；
  - 插值缺参、未知 key 和英文 fallback；
  - 相对时间在两种 locale 下不含硬编码英文片段。
- `tests/languages-test.ts`
  - `auto` 是合法 preference，但不是具体 `TranscriptLanguage`；
  - 缺偏好默认 auto；
  - 旧五种语言仍合法；
  - 顺序为 Auto + 现有五种语言。
- `tests/transcription-options-test.ts`
  - auto：`{ task: "transcribe" }`，无 `language` key；
  - zh：`{ task: "transcribe", language: "zh" }`；
  - en/es/fr/de 同理；
  - 没有任何分支返回 `translate`；
  - auto 的 `alignModelFor(undefined)` 为 null，zh 仍选中文 aligner。
- `tests/projects-test.ts`
  - 旧项目具体语言读取不变；
  - 缺字段/非法字段回退 auto；
  - 保存/读取 auto 不需要 DB 升级。

当前 CI 没有执行这些脚本式测试。最小做法是在 `package.json` 增加一个只运行上述快速纯函数测试的脚本，并在 `.github/workflows/ci.yml` 的 typecheck 后执行；不要顺手启用所有历史重型测试。

### 9.2 构建验证

必须通过现有检查：

```bash
npm ci
npm run lint
npx next typegen
npx tsc --noEmit
npm run typecheck:electron
npm run build
npm run build:electron
npm run export:desktop
```

额外确认：

- 不新增依赖，因此 `package-lock.json` 理论上不应发生依赖树变化；
- 静态导出仍能从 `app://` 加载 Worker 与字典；
- CSP/COOP/COEP 和 SharedArrayBuffer 行为不变；
- 首次模型下载与离线缓存行为不变。

### 9.3 真实音频验收矩阵

至少准备 10～30 秒、发音清晰的中文和英文各一段；中文最好同时包含标点可推断的完整句子。

| 模型 | 设置 | 音频 | 预期 |
| --- | --- | --- | --- |
| Whisper Base | Auto | 中文 | 输出中文，不出现整段英文翻译 |
| Whisper Small | Auto | 中文 | 输出中文，不出现整段英文翻译 |
| Whisper Base | 中文 | 中文 | 输出中文，并执行中文 CTC 对齐 |
| Whisper Base | English | 中文 | 允许出现英语约束结果；这是用户显式选择 |
| Whisper Base | Auto | 英文 | 输出英文 |
| Whisper Base | 中文 | 很短中文 | 输出中文，验证手动提示纠正短片段 |
| Parakeet | Auto | 其支持语种 | 保持后端自动识别；不承诺中文覆盖 |

同时检查：

- partial transcript 与最终 transcript 语种一致；
- 中文词/字块均有非负、递增时间戳；
- 时间轴删除、分割、导出字幕不因中文无空格而失败；
- SRT/VTT/TXT/MD 导出保持 UTF-8；
- 重新打开保存项目后中文不乱码；
- 首次离线缓存后断网重试仍能转录。

### 9.4 跨平台 UI 验收矩阵

| 环境 | 系统语言 | 偏好 | 预期 |
| --- | --- | --- | --- |
| Chrome/Edge | 中文 | 跟随系统 | 首屏简中，无英文闪屏 |
| Chrome/Edge | 英文 | 跟随系统 | 英文 |
| Chrome/Edge | 英文 | 简体中文 | 简中；刷新后保持 |
| Chrome/Edge | 中文 | English | 英文；刷新后保持 |
| macOS Electron | 中文/英文各一次 | 跟随/手动各一次 | 页面、菜单、更新框一致 |
| Windows Electron | 中文/英文各一次 | 跟随/手动各一次 | 页面、菜单、更新框一致 |
| Linux Electron | 中文/英文各一次 | 跟随/手动各一次 | 页面与菜单一致 |

重点人工检查 560×400 上传窗口和窄屏：中文文案不能撑破 Settings、ModelSelector、ExportDialog、时间轴工具栏。优先允许换行或略增 popover 宽度，不缩小字号。

## 10. 风险与控制

| 风险 | 影响 | 控制措施 |
| --- | --- | --- |
| 把 UI 语言当音频语言 | 中文界面转录英文音频时错误 | 两套类型、存储键和设置完全分离 |
| auto 仍落回 en | 中文继续变英文 | 测试对象中断言没有 language key；删除所有 `?? "en"` |
| 忘记 task | 依赖配置变化导致行为漂移 | helper 永远返回 `task: "transcribe"` 并测试 |
| auto 使用错误 CTC | 时间戳被错误语言模型破坏 | auto 首期跳过语言专用 CTC |
| Parakeet 设置语义误导 | 用户以为可强制输出中文 | UI 标出其 auto-only ASR 限制 |
| Worker 内保存旧 locale | 转录中切换语言后进度混杂 | Worker 发 stage/code，渲染器即时翻译 |
| 中文文案更宽/更高 | 小窗和菜单溢出 | 逐屏视觉测试；布局修复单独提交 |
| Electron 启动菜单短暂错语 | 手动偏好需等 renderer 同步 | 初始用 app.getLocale，renderer mount 后立即 IPC 重建 |
| 旧偏好被错误迁移 | 明确选英语的用户被改 auto | 保留所有已有合法具体值；仅“无值”默认 auto |
| 上游频繁变化导致冲突 | Fork 难维护 | 不改组件结构，不全局格式化，按边界拆小提交 |

## 11. “手术刀式”约束清单

实施 PR 必须遵守：

- 不添加 i18n npm 包；
- 不更换 Zustand、Worker、模型或对齐器；
- 不修改 Word/TimeRange/Speaker 等编辑核心数据结构；
- 不升级 IndexedDB DB_VERSION；
- 不更改 localStorage 旧键含义，只扩展合法值；
- 不更改模型下载 ID、dtype、VAD、chunk/stride、重复惩罚等已调优参数；
- 除新增 `task` 和可选 `language` 外，不改 Whisper 生成参数；
- 不在汉化提交中重排 JSX、改 className 或运行全库格式化；
- 不翻译日志/telemetry/Sentry 标识；
- 每个阶段都可单独 revert；
- 每次同步上游后先跑转录 options 单元测试，防止上游重新引入英语 fallback。

## 12. 完成定义

满足以下条件才算完成：

1. 新用户在中文系统上首次打开即看到简体中文；英文系统看到英文。
2. 设置可在“跟随系统 / English / 简体中文”间即时切换，刷新和重启后语义正确。
3. Web 与 Electron 主界面、菜单、更新对话框、进度、普通错误、无障碍文案语言一致。
4. 未设置转录偏好时显示 Auto，而不是隐式 English。
5. 中文音频使用 Whisper Base/Small + Auto 时输出中文；手动中文同样输出中文。
6. Worker 的 Whisper options 明确为 `task: "transcribe"`，自动模式不含 `language`，代码中无 `task: "translate"`。
7. 自动模式不会误用英语 CTC；手动中文仍使用现有中文 CTC 对齐器。
8. 旧的具体语言偏好和旧项目可无迁移打开。
9. 所有现有 CI 构建检查和新增纯函数测试通过。
10. 不增加运行时依赖、网络请求或模型下载；除用户手动指定语言时已有的对齐模型外，离线与缓存行为不变。

## 13. 建议的后续增强（不阻塞本次）

- 若需要自动模式也使用语言专用 CTC：研究并测试 Transformers.js 4.2.0 返回 Whisper 语言 token 的可靠路径，再把“检测到的具体语种”作为 Worker complete 元数据返回。
- 增加繁体中文 `zh-TW` 词库，而不是对简体词条做机械转换。
- 把官网、README、发行说明和下载页做多语言版本。
- 为可视组件引入 Playwright screenshot/aria smoke test；当前仓库没有 UI 自动化框架，不应塞进首个修复 PR。
- 如果未来支持三种以上 UI 语言或复杂复数规则，再评估 `next-intl`/ICU；届时可保留现有 key，不需要重翻文案。

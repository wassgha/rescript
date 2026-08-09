import { writeFile } from "node:fs/promises";

const endpoint = process.env.RESCRIPT_CDP_URL ?? "http://127.0.0.1:9223";
const [command = "inspect", argument] = process.argv.slice(2);

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new CdpClient(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "Runtime.evaluate failed");
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(client, expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await client.evaluate(expression);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

const pages = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const page = pages.find((candidate) => candidate.type === "page" && candidate.url.startsWith("app://"));
if (!page) throw new Error(`No Rescript page at ${endpoint}`);

const client = await CdpClient.connect(page.webSocketDebuggerUrl);
await client.send("Runtime.enable");

async function inspect() {
  return client.evaluate(`(() => ({
    title: document.title,
    htmlLang: document.documentElement.lang,
    crossOriginIsolated,
    inputReady: Boolean(document.querySelector('label input[type="file"]:not([disabled])')),
    uiLocale: localStorage.getItem('rescript.ui-locale'),
    transcriptLanguage: localStorage.getItem('rescript.transcript-language'),
    bodyText: document.body.innerText.slice(0, 8000)
  }))()`);
}

async function openSettings() {
  const opened = await client.evaluate(`(() => {
    if (document.querySelector('[role="dialog"] select')) return true;
    const button = [...document.querySelectorAll('button')].find((item) =>
      ['Settings', '设置'].includes(item.getAttribute('aria-label'))
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!opened) throw new Error("Settings button was not found");
  await waitFor(client, `Boolean(document.querySelector('[role="dialog"] select'))`);
}

async function changeSelect(optionValue) {
  await openSettings();
  const changed = await client.evaluate(`(() => {
    const select = [...document.querySelectorAll('[role="dialog"] select')].find((item) =>
      [...item.options].some((option) => option.value === ${JSON.stringify(optionValue)})
    );
    if (!select) return false;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    valueSetter.call(select, ${JSON.stringify(optionValue)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!changed) throw new Error(`No settings select supports ${optionValue}`);
}

if (command === "inspect") {
  console.log(JSON.stringify(await inspect(), null, 2));
} else if (command === "locale") {
  if (argument !== "en" && argument !== "zh-CN" && argument !== "system") {
    throw new Error("locale expects en, zh-CN, or system");
  }
  await changeSelect(argument);
  if (argument !== "system") {
    await waitFor(client, `document.documentElement.lang === ${JSON.stringify(argument)}`);
  }
  console.log(JSON.stringify(await inspect(), null, 2));
} else if (command === "language") {
  if (!argument) throw new Error("language expects a preference such as auto or zh");
  await changeSelect(argument);
  await waitFor(
    client,
    `localStorage.getItem('rescript.transcript-language') === ${JSON.stringify(argument)}`
  );
  console.log(JSON.stringify(await inspect(), null, 2));
} else if (command === "upload") {
  if (!argument) throw new Error("upload expects an absolute media path");
  await waitFor(client, `Boolean(document.querySelector('label input[type="file"]:not([disabled])'))`);
  const documentNode = await client.send("DOM.getDocument", { depth: -1, pierce: true });
  const inputNode = await client.send("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector: 'label input[type="file"]',
  });
  if (!inputNode.nodeId) throw new Error("Upload input was not found");
  await client.send("DOM.setFileInputFiles", { nodeId: inputNode.nodeId, files: [argument] });
  await client.evaluate(`(() => {
    const input = document.querySelector('label input[type="file"]');
    if (!input) return null;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files?.[0]?.name ?? null;
  })()`);
  await waitFor(client, `!document.querySelector('label input[type="file"]')`, 30_000);
  console.log(JSON.stringify(await inspect(), null, 2));
} else if (command === "status") {
  const status = await client.evaluate(`(() => {
    const words = [...document.querySelectorAll('.transcript-words [data-wid]')]
      .map((node) => node.textContent.trim())
      .filter(Boolean);
    const transcript = words.join('');
    const exportButton = [...document.querySelectorAll('button')].find((button) =>
      ['Export', '导出'].includes(button.textContent.trim())
    );
    return {
      htmlLang: document.documentElement.lang,
      ready: Boolean(exportButton && !exportButton.disabled && words.length),
      wordCount: words.length,
      cjkCount: (transcript.match(/[\\u3400-\\u9fff]/g) ?? []).length,
      englishWordCount: (transcript.match(/[A-Za-z]+/g) ?? []).length,
      transcript,
      bodyText: document.body.innerText.slice(0, 8000)
    };
  })()`);
  console.log(JSON.stringify(status, null, 2));
} else if (command === "diagnostics") {
  const diagnostics = await client.evaluate(`(async () => ({
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    resources: performance.getEntriesByType('resource')
      .filter((entry) => entry.name.includes('/vendor/ffmpeg'))
      .map((entry) => ({
        name: entry.name,
        duration: entry.duration,
        transferSize: entry.transferSize,
        decodedBodySize: entry.decodedBodySize
      })),
    vendorFetches: await Promise.all([
      '/vendor/ffmpeg/ffmpeg-core.js',
      '/vendor/ffmpeg/ffmpeg-core.wasm',
      '/vendor/ffmpeg/ffmpeg-core.worker.js',
      '/vendor/ffmpeg-class/worker.js'
    ].map(async (url) => {
      try {
        const response = await fetch(url);
        return { url, ok: response.ok, status: response.status, length: Number(response.headers.get('content-length')) || null };
      } catch (error) {
        return { url, error: String(error) };
      }
    }))
  }))()`);
  console.log(JSON.stringify(diagnostics, null, 2));
} else if (command === "bounds") {
  console.log(
    JSON.stringify(
      await client.evaluate(`({
        x: window.screenX,
        y: window.screenY,
        width: window.outerWidth,
        height: window.outerHeight,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight
      })`),
      null,
      2
    )
  );
} else if (command === "set-bounds") {
  const match = /^(\d+)x(\d+)$/.exec(argument ?? "");
  if (!match) throw new Error("set-bounds expects WIDTHxHEIGHT");
  await client.evaluate(
    `window.resizeTo(${Number(match[1])}, ${Number(match[2])}); true`
  );
  await sleep(500);
  console.log(
    JSON.stringify(
      await client.evaluate(`({
        x: window.screenX,
        y: window.screenY,
        width: window.outerWidth,
        height: window.outerHeight,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight
      })`),
      null,
      2
    )
  );
} else if (command === "close-window") {
  console.log(JSON.stringify(await client.evaluate(`window.close(); true`)));
} else if (command === "screenshot") {
  const outputPath = argument ?? "rescript-e2e.png";
  await client.send("Page.enable");
  const capture = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(outputPath, Buffer.from(capture.data, "base64"));
  console.log(outputPath);
} else {
  throw new Error(`Unknown command: ${command}`);
}

client.close();

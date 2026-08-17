const state = {
  sourceFile: null,
  sourceWorkbook: null,
  sourceSheet: null,
  rawItems: [],
  items: [],
  materials: new Map(),
  sourceMeta: null,
  outputBuffer: null,
  outputName: "",
  positionConflicts: [],
  classificationIssues: [],
  confirmedConflictSignature: "",
  previewBaseline: new Map(),
  deletedPreviewIds: new Set(),
  deletedReasons: new Map(),
  materialMeta: null,
  sourceFormat: "",
};

const MATERIAL_DB_NAME = "bom-material-database";
const MATERIAL_DB_VERSION = 1;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const normalized = (value) => String(value ?? "").replace(/[\s:_\-()（）]/g, "").toLowerCase();
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const dateCompact = (value) => String(value || "").replace(/-/g, "");
function cellText(cell) {
  try { return String(cell.text ?? "").trim(); } catch (_) {
    const value = cell.value;
    if (value == null) return "";
    if (typeof value === "object") {
      if (value.result != null) return String(value.result).trim();
      if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("").trim();
      return "";
    }
    return String(value).trim();
  }
}

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const today = new Date().toISOString().slice(0, 10);
  $("#record-date").value = today;
  bindEvents();
  await loadDefaultMaterials();
}

function bindEvents() {
  const dropzone = $("#dropzone");
  $("#source-file").addEventListener("change", (event) => handleSourceFile(event.target.files[0]));
  $("#db-file").addEventListener("change", (event) => importMaterialDatabases([...event.target.files]));
  $("#clear-db").addEventListener("click", clearLocalMaterialDatabase);
  $("#export-db").addEventListener("click", exportMaterialDatabase);
  ["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragging");
  }));
  dropzone.addEventListener("drop", (event) => handleSourceFile(event.dataTransfer.files[0]));
  $("#to-step-2").addEventListener("click", preparePreview);
  $("#metadata-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!event.currentTarget.checkValidity()) return event.currentTarget.reportValidity();
    await downloadOutput();
  });
  $("#metadata-form").addEventListener("input", updateMetadataSubmitState);
  $$('[data-back]').forEach((button) => button.addEventListener("click", () => goToStep(Number(button.dataset.back))));
  $("#to-step-3").addEventListener("click", () => {
    if (previewCanProceed()) return goToStep(3);
    const pending = previewPendingItems().length;
    toast(`还有 ${pending} 行尚未完成确认。请完成修改并点击“确认”，或删除不需要的行。`);
  });
  $("#recheck-button").addEventListener("click", () => applyPreviewEditsAndRecheck(true, true));
  $("#preview-body").addEventListener("click", handlePreviewAction);
  $("#preview-body").addEventListener("input", debounce((event) => {
    if (event.target.matches("[data-material-line]")) return;
    applyPreviewEditsAndRecheck(false, false);
  }, 260));
  $("#preview-body").addEventListener("change", (event) => {
    if (event.target.matches("[data-material-line]")) return;
    applyPreviewEditsAndRecheck(true, false);
  });
  $("#confirm-conflicts").addEventListener("change", (event) => {
    state.confirmedConflictSignature = event.target.checked ? conflictSignature() : "";
    state.items.filter((item) => item.conflictingPositions.length).forEach((item) => {
      item.confirmedConflictSignature = event.target.checked ? itemConflictSignature(item) : "";
      if (event.target.checked) item.userModified = true;
    });
    renderPreview();
  });
  updateMetadataSubmitState();
}

async function loadDefaultMaterials() {
  try {
    const indexed = await readIndexedMaterials();
    if (indexed.records.length) {
      await setMaterials(indexed.records, false, indexed.meta);
      return;
    }
    const legacy = localStorage.getItem("bom-materials-v1");
    if (legacy) {
      const records = JSON.parse(legacy);
      await setMaterials(records, true, { fileName: "旧版浏览器物料库", importedAt: new Date().toISOString(), migrated: true });
      localStorage.removeItem("bom-materials-v1");
      toast(`已将旧版物料库的 ${state.materials.size} 条记录迁移到 IndexedDB。`);
      return;
    }
    await setMaterials([], false, null);
  } catch (error) {
    console.error(error);
    await setMaterials([], false, null);
    toast("本地物料库读取失败，请重新导入总表。");
  }
}

async function setMaterials(records, persist = true, meta = null) {
  const cleanRecords = normalizeMaterialRecords(records);
  const nextMaterials = new Map(cleanRecords.map((record) => [record.code, record]));
  if (persist) await replaceIndexedMaterials([...nextMaterials.values()], meta);
  state.materials = nextMaterials;
  state.materialMeta = meta;
  $("#db-count").textContent = `已加载 ${state.materials.size} 条物料`;
  $("#db-meta").textContent = meta?.fileName
    ? `${meta.fileName} · ${formatImportedTime(meta.importedAt)}`
    : "尚未导入本地物料总表";
  $("#clear-db").disabled = state.materials.size === 0;
  $("#export-db").disabled = state.materials.size === 0;
}

function normalizeMaterialRecords(records) {
  return records
    .map((record) => ({
      code: String(record.code ?? recordField(record, ["12位编码", "物料编码", "物资编码", "编码"]) ?? "").trim(),
      name: String(record.name ?? recordField(record, ["物料名称", "物资名称", "名称"]) ?? "").trim(),
      model: String(record.model ?? recordField(record, ["规格型号", "规格", "型号"]) ?? "").trim(),
      package: String(record.package ?? recordField(record, ["封装", "封装形式"]) ?? "").trim(),
    }))
    .filter((record) => record.code);
}

function openMaterialDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("当前浏览器不支持 IndexedDB。"));
    const request = indexedDB.open(MATERIAL_DB_NAME, MATERIAL_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("materials")) database.createObjectStore("materials", { keyPath: "code" });
      if (!database.objectStoreNames.contains("meta")) database.createObjectStore("meta", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readIndexedMaterials() {
  const database = await openMaterialDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["materials", "meta"], "readonly");
    const recordsRequest = transaction.objectStore("materials").getAll();
    const metaRequest = transaction.objectStore("meta").get("database");
    transaction.oncomplete = () => {
      database.close();
      resolve({ records: recordsRequest.result || [], meta: metaRequest.result?.value || null });
    };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
  });
}

async function replaceIndexedMaterials(records, meta) {
  const database = await openMaterialDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["materials", "meta"], "readwrite");
    const materialStore = transaction.objectStore("materials");
    const metaStore = transaction.objectStore("meta");
    materialStore.clear();
    records.forEach((record) => materialStore.put(record));
    metaStore.clear();
    if (meta) metaStore.put({ key: "database", value: meta });
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
  });
}

async function upsertIndexedMaterial(record) {
  const database = await openMaterialDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction("materials", "readwrite");
    transaction.objectStore("materials").put(record);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
  state.materials.set(record.code, record);
  $("#db-count").textContent = `已加载 ${state.materials.size} 条物料`;
  $("#clear-db").disabled = false;
  $("#export-db").disabled = false;
}

async function clearLocalMaterialDatabase() {
  if (!state.materials.size || !window.confirm("确定清除当前浏览器保存的物料数据库吗？清除后需要重新导入总表。")) return;
  try {
    await replaceIndexedMaterials([], null);
    await setMaterials([], false, null);
    if (state.rawItems.length) enrichItems();
    toast("本地物料数据库已清除。");
  } catch (error) {
    console.error(error);
    toast("清除失败，请稍后重试。");
  }
}

function formatImportedTime(value) {
  if (!value) return "导入时间未知";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function recordField(record, aliases) {
  const aliasSet = new Set(aliases.map(normalized));
  const entry = Object.entries(record).find(([key]) => aliasSet.has(normalized(key)));
  return entry?.[1];
}

async function importMaterialDatabases(files) {
  if (!files.length) return;
  try {
    const records = [];
    let importedSheets = 0;
    for (const file of files) {
      if (file.name.toLowerCase().endsWith(".csv")) {
        records.push(...parseCsv(await file.text()));
        importedSheets += 1;
      } else {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(await file.arrayBuffer());
        workbook.worksheets.forEach((worksheet) => {
          const sheetRecords = worksheetToObjects(worksheet);
          if (sheetRecords.length) {
            records.push(...sheetRecords);
            importedSheets += 1;
          }
        });
      }
    }
    if (!records.length) throw new Error("所有文件和工作表中都未找到物料编码表头。");
    const incoming = new Map(normalizeMaterialRecords(records).map((record) => [record.code, record]));
    const conflicts = [...incoming.values()].filter((record) => {
      const existing = state.materials.get(record.code);
      return existing && materialContentDiffers(existing, record);
    }).map((record) => ({ existing: state.materials.get(record.code), incoming: record }));
    const decisions = conflicts.length ? await showMaterialConflictDialog(conflicts) : new Map();
    if (decisions === null) return toast("已取消本次导入，原物料库未发生变化。");
    const merged = new Map(state.materials);
    let added = 0;
    let overwritten = 0;
    let kept = 0;
    incoming.forEach((record, code) => {
      const existing = state.materials.get(code);
      if (!existing) { merged.set(code, record); added += 1; return; }
      if (materialContentDiffers(existing, record) && decisions.get(code) !== "incoming") { kept += 1; return; }
      merged.set(code, record);
      if (materialContentDiffers(existing, record)) overwritten += 1;
    });
    const meta = {
      fileName: `导入：${files.map((file) => file.name).join("、")}`,
      importedAt: new Date().toISOString(), fileCount: files.length, sheetCount: importedSheets,
      added, overwritten, kept,
    };
    await setMaterials([...merged.values()], true, meta);
    toast(`总表导入完成：新增 ${added} 条，覆盖 ${overwritten} 条，保留原数据 ${kept} 条，共 ${state.materials.size} 条。`);
    if (state.rawItems.length) enrichItems();
  } catch (error) {
    console.error(error);
    toast("物料库导入失败，请检查表头和文件格式。");
  } finally {
    $("#db-file").value = "";
  }
}

function materialContentDiffers(left, right) {
  return ["name", "model", "package"].some((field) => normalizeMaterialContent(left[field]) !== normalizeMaterialContent(right[field]));
}

function normalizeMaterialContent(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[\s\-_/\\.,，。:：;；()（）\[\]【】]/g, "");
}

function showMaterialConflictDialog(conflicts) {
  const modal = $("#material-conflict-modal");
  const body = $("#material-conflict-body");
  $("#material-conflict-count").textContent = `发现 ${conflicts.length} 个相同编码存在内容差异`;
  body.innerHTML = conflicts.map(({ existing, incoming }, index) => `<tr>
    <td>${escapeHtml(existing.code)}</td>
    <td>${materialRecordHtml(existing)}</td>
    <td>${materialRecordHtml(incoming)}</td>
    <td><label><input type="radio" name="material-choice-${index}" value="existing" checked> 保留现有</label><label><input type="radio" name="material-choice-${index}" value="incoming"> 使用新数据</label></td>
  </tr>`).join("");
  modal.classList.remove("hidden");
  return new Promise((resolve) => {
    $("#cancel-material-conflicts").onclick = () => { modal.classList.add("hidden"); resolve(null); };
    $("#confirm-material-conflicts").onclick = () => {
      const decisions = new Map(conflicts.map(({ existing }, index) => [existing.code, document.querySelector(`input[name="material-choice-${index}"]:checked`).value]));
      modal.classList.add("hidden");
      resolve(decisions);
    };
  });
}

function materialRecordHtml(record) {
  return `<div><b>名称：</b>${escapeHtml(record.name || "（空）")}</div><div><b>型号：</b>${escapeHtml(record.model || "（空）")}</div><div><b>封装：</b>${escapeHtml(record.package || "（空）")}</div>`;
}

async function exportMaterialDatabase() {
  if (!state.materials.size) return toast("当前没有可导出的物料数据。");
  const button = $("#export-db");
  button.disabled = true;
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("物料总表", { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.addRow(["12位编码", "物料名称", "规格型号", "封装"]);
    [...state.materials.values()].sort((a, b) => a.code.localeCompare(b.code, "zh-CN", { numeric: true })).forEach((record) => sheet.addRow([record.code, record.name, record.model, record.package]));
    sheet.columns = [{ width: 18 }, { width: 24 }, { width: 42 }, { width: 18 }];
    sheet.getRow(1).height = 28;
    sheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 12 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2A3134" } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      row.height = Math.max(24, Math.min(72, Math.ceil(visualTextLength(String(row.getCell(3).value || "")) / 38) * 17));
      row.eachCell((cell) => { cell.font = { size: 11 }; cell.alignment = { vertical: "middle", wrapText: true }; });
    }
    const buffer = await workbook.xlsx.writeBuffer();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    link.download = `物料总表_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.xlsx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast(`已导出 ${state.materials.size} 条物料。`);
  } catch (error) {
    console.error(error);
    toast("物料总表导出失败，请稍后重试。");
  } finally {
    button.disabled = state.materials.size === 0;
  }
}

function parseCsv(text) {
  const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean).map((line) => {
    const result = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"' && line[i + 1] === '"') { current += '"'; i += 1; }
      else if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) { result.push(current); current = ""; }
      else current += char;
    }
    result.push(current);
    return result;
  });
  const headers = rows.shift() || [];
  return rows.map((row) => Object.fromEntries(headers.map((header, index) => [header.trim(), row[index] ?? ""])));
}

function worksheetToObjects(worksheet) {
  let headerRow = 0;
  for (let row = 1; row <= Math.min(worksheet.rowCount, 30); row += 1) {
    if ([...worksheet.getRow(row).values].some((value) => ["12位编码", "物料编码", "物资编码", "编码"].map(normalized).includes(normalized(value)))) {
      headerRow = row;
      break;
    }
  }
  if (!headerRow) return [];
  const headers = [];
  worksheet.getRow(headerRow).eachCell({ includeEmpty: true }, (cell, column) => headers[column] = cellText(cell));
  const records = [];
  for (let row = headerRow + 1; row <= worksheet.rowCount; row += 1) {
    const record = {};
    headers.forEach((header, column) => { if (header) record[header] = cellText(worksheet.getCell(row, column)); });
    if (Object.values(record).some(Boolean)) records.push(record);
  }
  return records;
}

async function handleSourceFile(file) {
  if (!file) return;
  if (!/\.(bom|xlsx|xlsm)$/i.test(file.name)) return toast("请选择 .BOM、.xlsx 或 .xlsm 文件。");
  if (file.size > 20 * 1024 * 1024) return toast("文件超过 20 MB，请精简后重试。");
  try {
    const isBom = /\.bom$/i.test(file.name);
    let workbook = null;
    let parsed;
    if (isBom) {
      parsed = parseBomSource(await file.arrayBuffer());
    } else {
      workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await file.arrayBuffer());
      parsed = parseSourceWorkbook(workbook);
    }
    state.sourceFile = file;
    state.sourceWorkbook = workbook;
    state.sourceSheet = parsed.sheet || null;
    state.sourceFormat = isBom ? "bom" : "excel";
    state.rawItems = parsed.items;
    state.sourceMeta = isBom ? readBomMetadata(file.name) : readSourceMetadata(workbook, file.name);
    if (isBom && state.sourceMeta.dateInput) $("#record-date").value = state.sourceMeta.dateInput;
    enrichItems();
    showFileCard(file, parsed.items.length, parsed.sheetName || parsed.sheet.name);
    $("#to-step-2").disabled = false;
    const mismatchCount = parsed.items.filter((item) => item.quantityMismatch).length;
    toast(`已读取 ${parsed.items.length} 条原始记录${mismatchCount ? `，${mismatchCount} 条数量需要核对` : ""}。`);
  } catch (error) {
    console.error(error);
    resetSource();
    toast(error.message || "清单读取失败。");
  }
}

function parseBomSource(buffer) {
  const text = decodeBomText(buffer).replace(/^\uFEFF/, "");
  const rows = parseDelimitedRows(text, "\t");
  const headerIndex = rows.findIndex((row) => {
    const keys = row.map(normalized);
    return ["item", "quantity", "reference", "part", "ggxh"].every((key) => keys.includes(key));
  });
  if (headerIndex < 0) throw new Error("BOM 中未找到 Item、Quantity、Reference、Part、GGXH 表头。");
  const headers = rows[headerIndex].map(normalized);
  const columns = Object.fromEntries(["item", "quantity", "reference", "part", "ggxh"].map((key) => [key, headers.indexOf(key)]));
  const items = [];
  rows.slice(headerIndex + 1).forEach((row, offset) => {
    const sourceItem = String(row[columns.item] || "").trim();
    const positionsText = String(row[columns.reference] || "").trim();
    const sourcePart = String(row[columns.part] || "").trim();
    const sourceModel = String(row[columns.ggxh] || "").trim();
    if (!positionsText || !sourceModel || /^_+$/.test(sourceItem)) return;
    const positions = splitPositions(positionsText);
    const sourceQuantity = Number(String(row[columns.quantity] || "").trim());
    items.push({
      code: "", positions, positionsText, classification: "B类",
      sourceRow: headerIndex + offset + 2, sourceItem, sourcePart, sourceModel,
      sourceQuantity: Number.isFinite(sourceQuantity) ? sourceQuantity : null,
      quantityMismatch: Number.isFinite(sourceQuantity) && sourceQuantity !== positions.length,
      sourceType: "bom",
    });
  });
  if (!items.length) throw new Error("找到了 BOM 表头，但没有可处理的物料数据。");
  return { sheetName: "原始 BOM", items };
}

function decodeBomText(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (_) {
    try { return new TextDecoder("gb18030").decode(buffer); }
    catch (_) { throw new Error("BOM 文本编码无法识别，请确认文件由 Candace 正常导出。"); }
  }
}

function parseDelimitedRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && quoted && text[index + 1] === '"') { field += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function parseSourceWorkbook(workbook) {
  for (const sheet of workbook.worksheets) {
    for (let row = 1; row <= Math.min(sheet.rowCount, 40); row += 1) {
      const headers = {};
      sheet.getRow(row).eachCell({ includeEmpty: false }, (cell, column) => {
        const key = normalized(cellText(cell));
        if (key.includes("12位编码") || key === "编码" || key === "物料编码") headers.code = column;
        if (key === "位号" || key.includes("位号清单") || key === "位置号") headers.positions = column;
        if (key === "物资分类" || key === "物料分类") headers.classification = column;
      });
      if (headers.code && headers.positions) return { sheet, items: readSourceRows(sheet, row, headers) };
    }
  }
  throw new Error("未找到同时包含“12位编码”和“位号”的表头。");
}

function readSourceRows(sheet, headerRow, headers) {
  const items = [];
  for (let row = headerRow + 1; row <= sheet.rowCount; row += 1) {
    const code = cellText(sheet.getCell(row, headers.code)).replace(/\s/g, "");
    const positionsText = cellText(sheet.getCell(row, headers.positions));
    const classification = headers.classification ? cellText(sheet.getCell(row, headers.classification)) : "";
    if (!code && !positionsText) continue;
    if (["12位编码", "物料编码", "物资编码", "编码"].map(normalized).includes(normalized(code))) continue;
    const positions = splitPositions(positionsText);
    items.push({ code, positions, positionsText, classification, sourceRow: row });
  }
  if (!items.length) throw new Error("找到了表头，但没有可处理的物料数据。");
  return items;
}

function splitPositions(value) {
  return [...new Set(String(value || "").split(/[,，;；\s]+/).map((item) => item.trim()).filter(Boolean))];
}

function normalizeSpecification(value) {
  return String(value || "").normalize("NFKC").toUpperCase()
    .replace(/[µμ]/g, "U")
    .replace(/[×✕]/g, "X")
    .replace(/(\d)[,，](?=\d)/g, "$1.")
    .replace(/[^\p{L}\p{N}.]+/gu, "");
}

function findMaterialsByModel(model) {
  const key = normalizeSpecification(model);
  if (!key) return [];
  const materials = [...state.materials.values()];
  const exact = materials.filter((material) => normalizeSpecification(material.model) === key);
  if (exact.length) return exact;
  return materials.filter((material) => normalizeSpecification(material.model).includes(key));
}

function hasNcMarker(item) {
  return /(?:^|\/)\s*NC\s*(?:\/|$)/i.test(item.sourceModel || item.model || "")
    || /(?:^|\/)\s*NC\s*(?:\/|$)/i.test(item.sourcePart || "");
}

function resistorPrecision(model) {
  const text = String(model || "").normalize("NFKC").toUpperCase().replace(/\s+/g, "");
  const tolerance = text.match(/(?:±|\+\/-?)(\d+(?:\.\d+)?)%/) || text.match(/(\d+(?:\.\d+)?)%$/);
  if (!tolerance || !/(?:^|[-_/])R(?:C|S)?[-_/]|电阻/i.test(text)) return null;
  const percent = Number(tolerance[1]);
  if (!Number.isFinite(percent)) return null;
  return {
    percent,
    family: normalizeSpecification(text.replace(tolerance[0], "")),
  };
}

function resolveRawSourceItem(item) {
  if (item.sourceType !== "bom") return { ...item, matchCandidates: [] };
  const candidates = findMaterialsByModel(item.sourceModel);
  return {
    ...item,
    code: candidates.length === 1 ? candidates[0].code : "",
    matchCandidates: candidates.map((candidate) => candidate.code),
  };
}

function enrichItems() {
  const merged = new Map();
  state.rawItems.map(resolveRawSourceItem).forEach((item, index) => {
    const key = item.code || (item.sourceType === "bom" ? `__model_${normalizeSpecification(item.sourceModel)}_${normalizeSpecification(item.sourcePart)}` : `__blank_${index}`);
    if (!merged.has(key)) merged.set(key, {
      code: item.code, positions: [], classification: item.classification || "B类", rows: [],
      sourceType: item.sourceType || "excel", sourcePart: item.sourcePart || "", sourceModel: item.sourceModel || "",
      sourceQuantity: 0, matchCandidates: item.matchCandidates || [], quantityMismatch: false,
    });
    const target = merged.get(key);
    target.positions = [...new Set([...target.positions, ...item.positions])];
    target.rows.push(item.sourceRow);
    if (Number.isFinite(item.sourceQuantity)) target.sourceQuantity += item.sourceQuantity;
    target.quantityMismatch ||= Boolean(item.quantityMismatch);
    target.matchCandidates = [...new Set([...target.matchCandidates, ...(item.matchCandidates || [])])];
  });
  state.items = [...merged.values()].map((item, index) => ({
    ...item, previewId: `item-${index}`, quantity: item.positions.length, name: "",
    model: item.sourceType === "bom" ? item.sourceModel : "", package: "",
    quantityMismatch: item.quantityMismatch || (item.sourceQuantity > 0 && item.sourceQuantity !== item.positions.length),
  }));
  validateItems(state.items);
}

function validateItems(items) {
  items.forEach((item) => {
    let material = state.materials.get(item.code);
    let validFormat = /^\d{12}$/.test(item.code);
    if (item.sourceType === "bom" && !validFormat) {
      const candidates = findMaterialsByModel(item.model || item.sourceModel);
      item.matchCandidates = candidates.map((candidate) => candidate.code);
      if (candidates.length === 1) {
        item.code = candidates[0].code;
        material = candidates[0];
        validFormat = true;
      }
    }
    item.name = item.name || material?.name || "";
    item.model = item.model || material?.model || "";
    item.package = item.package || material?.package || "";
    item.quantity = item.positions.length;
    const manuallyComplete = Boolean(item.name && item.model && item.package);
    item.status = material ? "ok"
      : item.sourceType === "bom" && !validFormat && item.matchCandidates.length > 1 ? "model_ambiguous"
      : item.sourceType === "bom" && !validFormat ? "model_missing"
      : manuallyComplete && validFormat ? "manual"
      : !validFormat ? "format" : "missing";
    item.ncRequired = hasNcMarker(item);
    if (!item.ncRequired) item.ncDecision = "";
    item.precisionSuggestion = null;
  });
  items.forEach((item) => {
    const current = resistorPrecision(item.model || item.sourceModel);
    if (!current) return;
    const better = items
      .map((candidate) => ({ candidate, parsed: resistorPrecision(candidate.model || candidate.sourceModel) }))
      .filter(({ candidate, parsed }) => candidate !== item && parsed?.family === current.family && parsed.percent < current.percent)
      .sort((a, b) => a.parsed.percent - b.parsed.percent)[0];
    if (better) item.precisionSuggestion = {
      targetPreviewId: better.candidate.previewId,
      targetModel: better.candidate.model || better.candidate.sourceModel,
      targetPercent: better.parsed.percent,
    };
    else item.precisionDecision = "";
  });
  const positionOwners = new Map();
  items.forEach((item, itemIndex) => item.positions.forEach((position) => {
    const key = position.toUpperCase();
    if (!positionOwners.has(key)) positionOwners.set(key, { position, owners: new Set(), codes: new Set() });
    const entry = positionOwners.get(key);
    entry.owners.add(item.previewId || `row-${itemIndex}`);
    entry.codes.add(item.code || item.sourceModel || item.model || `未填写行 ${itemIndex + 1}`);
  }));
  state.positionConflicts = [...positionOwners.values()]
    .filter((entry) => entry.owners.size > 1)
    .map((entry) => ({ position: entry.position, codes: [...entry.codes], owners: [...entry.owners] }));
  const conflictKeys = new Set(state.positionConflicts.map((entry) => entry.position.toUpperCase()));
  items.forEach((item) => {
    item.conflictingPositions = item.positions.filter((position) => conflictKeys.has(position.toUpperCase()));
    const currentSignature = itemConflictSignature(item);
    if (item.confirmedConflictSignature !== currentSignature) item.confirmedConflictSignature = "";
  });
  const mainCodes = new Set(items.filter((item) => item.classification === "A类主选").map((item) => item.code));
  state.classificationIssues = [];
  items.forEach((item) => {
    if (item.classification !== "A类备选") item.linkedMainCode = "";
    item.classificationIssue = item.classification === "A类备选" && !mainCodes.has(item.linkedMainCode)
      ? "请选择关联的A类主选"
      : "";
    if (item.classificationIssue) state.classificationIssues.push(item);
  });
}

function readSourceMetadata(workbook, fileName = "") {
  const updateSheet = workbook.getWorksheet("清单更新记录");
  const componentSheet = workbook.getWorksheet("元件清单");
  const title = componentSheet ? cellText(componentSheet.getCell("D1")) : "";
  const history = updateSheet ? readHistory(updateSheet) : [];
  const detectedVersion = history[0]?.version || title.match(/V\d+(?:\.\d+)+/i)?.[0] || extractFileVersion(fileName);
  const version = detectedVersion || "V1.0.0";
  const latest = history[0] || {};
  const headerApprovals = {
    compile: componentSheet ? cellText(componentSheet.getCell("I1")) : "",
    review: componentSheet ? cellText(componentSheet.getCell("I2")) : "",
    approve: componentSheet ? cellText(componentSheet.getCell("I3")) : "",
  };
  return {
    version,
    hasVersion: Boolean(detectedVersion),
    nextVersion: detectedVersion ? incrementVersion(version) : "V1.0.0",
    title,
    history,
    names: {
      compile: extractPerson(latest.compile || headerApprovals.compile, "编制"),
      review: extractPerson(latest.review || headerApprovals.review, "审核"),
      approve: extractPerson(latest.approve || headerApprovals.approve, "批准"),
    },
  };
}

function readBomMetadata(fileName) {
  const detectedVersion = extractFileVersion(fileName);
  const detectedDate = extractFileDate(fileName);
  return {
    version: detectedVersion || "V1.0.0",
    hasVersion: Boolean(detectedVersion),
    nextVersion: detectedVersion || "V1.0.0",
    date: detectedDate,
    dateInput: detectedDate ? `${detectedDate.slice(0, 4)}-${detectedDate.slice(4, 6)}-${detectedDate.slice(6, 8)}` : "",
    title: fileName.replace(/\.bom$/i, ""),
    history: [],
    names: { compile: "", review: "", approve: "" },
  };
}

function extractFileVersion(fileName) {
  const match = String(fileName || "").match(/V(\d+)[._](\d+)[._](\d+)/i);
  return match ? `V${match[1]}.${match[2]}.${match[3]}` : "";
}

function extractFileDate(fileName) {
  const text = String(fileName || "");
  const compactMatches = [...text.matchAll(/(?:^|[_.-])(20\d{6})(?=$|[_.-])/g)];
  if (compactMatches.length) return compactMatches.at(-1)[1];
  const separatedMatches = [...text.matchAll(/(?:^|[_.-])(20\d{2})[_.-](0[1-9]|1[0-2])[_.-](0[1-9]|[12]\d|3[01])(?=$|[_.-])/g)];
  const match = separatedMatches.at(-1);
  return match ? `${match[1]}${match[2]}${match[3]}` : "";
}

function readHistory(sheet) {
  const records = [];
  for (let row = 3; row <= sheet.rowCount; row += 1) {
    const sequence = cellText(sheet.getCell(row, 1));
    const version = cellText(sheet.getCell(row, 2));
    if (!version || !/^V\d/i.test(version)) continue;
    records.push({
      sequence: Number(sequence) || records.length + 1,
      version,
      date: cellText(sheet.getCell(row, 3)),
      note: cellText(sheet.getCell(row, 4)),
      compile: cellText(sheet.getCell(row, 8)),
      review: cellText(sheet.getCell(row + 1, 8)),
      approve: cellText(sheet.getCell(row + 2, 8)),
    });
    row += 2;
  }
  const unique = new Map();
  records.forEach((record) => {
    const key = [record.version, record.date, record.note, record.compile, record.review, record.approve].join("\u0001");
    if (!unique.has(key)) unique.set(key, record);
    else unique.get(key).sequence = Math.min(unique.get(key).sequence, record.sequence);
  });
  const result = [...unique.values()];
  return result.map((record, index) => ({ ...record, sequence: result.length - index }));
}

function extractPerson(text, label) {
  const value = String(text || "").replace(new RegExp(`^${label}[：:]?`), "").replace(/\d{8}\s*$/, "").trim();
  return value;
}

function incrementVersion(version) {
  const match = String(version).match(/^(V?)(\d+(?:\.\d+)*)$/i);
  if (!match) return "V1.0.0";
  const parts = match[2].split(".").map(Number);
  parts[parts.length - 1] += 1;
  return `V${parts.join(".")}`;
}

function showFileCard(file, count, sheetName) {
  const card = $("#file-card");
  card.classList.remove("hidden");
  card.innerHTML = `<div><span class="file-icon">X</span><div><strong>${escapeHtml(file.name)}</strong><small>${formatBytes(file.size)} · ${escapeHtml(sheetName)} · ${count} 条记录</small></div></div><button class="remove-file" aria-label="移除文件">×</button>`;
  card.querySelector("button").addEventListener("click", resetSource);
}

function resetSource() {
  state.sourceFile = null;
  state.sourceWorkbook = null;
  state.sourceSheet = null;
  state.sourceFormat = "";
  state.rawItems = [];
  state.items = [];
  state.sourceMeta = null;
  state.positionConflicts = [];
  state.confirmedConflictSignature = "";
  state.previewBaseline = new Map();
  state.deletedPreviewIds = new Set();
  state.deletedReasons = new Map();
  $("#source-file").value = "";
  $("#file-card").classList.add("hidden");
  $("#to-step-2").disabled = true;
}

function goToStep(step) {
  $$(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${step}`));
  $$(".step").forEach((item) => item.classList.toggle("active", Number(item.dataset.step) === step));
  if (step === 3 && state.sourceMeta) {
    const names = state.sourceMeta.names;
    $("#compile-name").value = $("#compile-name").value || names.compile || "";
    $("#review-name").value = $("#review-name").value || names.review || "";
    $("#approve-name").value = $("#approve-name").value || names.approve || "";
    if (state.sourceFormat === "bom" && state.sourceMeta.dateInput) $("#record-date").value = state.sourceMeta.dateInput;
    const versionMessage = state.sourceMeta.hasVersion
      ? state.sourceFormat === "bom"
        ? `已识别 BOM 版本 <strong>${escapeHtml(state.sourceMeta.version)}</strong>，本次默认沿用该版本${state.sourceMeta.date ? `；日期沿用 <strong>${escapeHtml(state.sourceMeta.date)}</strong>` : ""}`
        : `已识别原版本 <strong>${escapeHtml(state.sourceMeta.version)}</strong>，本次将生成 <strong>${escapeHtml(state.sourceMeta.nextVersion)}</strong>`
      : `未识别到版本号，本次将自动补充为 <strong>${escapeHtml(state.sourceMeta.nextVersion)}</strong>`;
    $("#detected-info").innerHTML = `${versionMessage}。<br>沿用人员：编制 ${escapeHtml(names.compile || "未填写")} · 审核 ${escapeHtml(names.review || "未填写")} · 批准 ${escapeHtml(names.approve || "未填写")}。`;
    renderMetadataChangeSummary();
    updateMetadataSubmitState();
  }
  window.scrollTo({ top: document.querySelector(".workspace").offsetTop - 18, behavior: "smooth" });
}

async function preparePreview() {
  if (!state.items.length) return toast("请先上传元件清单。");
  enrichItems();
  state.previewBaseline = new Map(state.items.map((item) => [item.previewId, previewComparable(item)]));
  state.deletedPreviewIds = new Set();
  state.deletedReasons = new Map();
  renderPreview();
  goToStep(2);
  state.outputBuffer = null;
}

function renderPreview() {
  renderPreviewSummary();
  const mainItems = state.items.filter((item) => item.classification === "A类主选");
  const confirmed = Boolean(conflictSignature() && state.confirmedConflictSignature === conflictSignature());
  const sortedItems = state.items.map((item, sourceIndex) => ({ item, sourceIndex })).sort((a, b) => issueRank(a.item) - issueRank(b.item) || a.sourceIndex - b.sourceIndex);
  $("#preview-body").innerHTML = sortedItems.map(({ item, sourceIndex }, displayIndex) => {
    const isError = isItemError(item);
    const editable = isPreviewItemEditable(item);
    const rowClass = [
      isError || item.classificationIssue ? "error-row" : item.conflictingPositions.length || (item.quantityMismatch && !item.quantityConfirmed) || (item.ncRequired && !item.ncDecision) || (item.precisionSuggestion && !item.precisionDecision) ? "warning-row" : "",
      item.userModified ? "modified-row" : "",
      editable ? "editing-row" : "",
      isThroughHoleComponent(item) ? "through-hole-row" : "",
      item.classification === "A类主选" ? "relation-main-row" : item.classification === "A类备选" ? "relation-backup-row" : "",
    ].filter(Boolean).join(" ");
    const classifications = ["B类", "A类主选", "A类备选"];
    const field = (name, value, textarea = false) => editable
      ? textarea ? `<textarea class="preview-textarea" data-field="${name}">${escapeHtml(value)}</textarea>` : `<input class="preview-input" data-field="${name}" value="${escapeHtml(value)}">`
      : `<span class="preview-readonly">${escapeHtml(value || "—")}</span>`;
    const classification = editable
      ? `<select class="preview-select" data-field="classification">${classifications.map((value) => `<option value="${value}" ${value === item.classification ? "selected" : ""}>${value}</option>`).join("")}</select>${item.classification === "A类备选" ? `<select class="preview-select classification-link" data-field="linkedMainCode"><option value="">请选择关联主选</option>${mainItems.filter((main) => main !== item).map((main) => `<option value="${escapeHtml(main.code)}" ${main.code === item.linkedMainCode ? "selected" : ""}>${escapeHtml(main.code)} · ${escapeHtml(main.name || "未命名")}</option>`).join("")}</select>` : ""}`
      : `<span class="preview-readonly">${escapeHtml(item.classification)}</span>${item.classification === "A类备选" ? `<small class="relation-note">关联：${escapeHtml(item.linkedMainCode)}</small>` : ""}`;
    const codeField = editable && item.matchCandidates?.length > 1 && !item.code
      ? `<select class="preview-select" data-field="code"><option value="">请选择 12 位编码</option>${item.matchCandidates.map((code) => {
          const material = state.materials.get(code);
          return `<option value="${escapeHtml(code)}">${escapeHtml(code)} · ${escapeHtml(material?.name || "未命名")}</option>`;
        }).join("")}</select>`
      : field("code", item.code);
    const useMaterialLineEntry = isError && item.status !== "model_ambiguous" && !item.bulkParsed;
    const materialCells = useMaterialLineEntry
      ? `<td colspan="4" class="material-lookup-cell"><div class="material-line-entry"><textarea data-material-line placeholder="12位编码  物料名称  规格型号  封装">${escapeHtml(item.bulkInput || "")}</textarea><button type="button" data-action="parse-material-line">识别物料</button></div></td>`
      : `<td>${codeField}</td><td>${field("name", item.name, true)}</td><td>${field("model", item.model, true)}</td><td>${field("package", item.package, true)}</td>`;
    return `<tr class="${rowClass}" data-source-index="${sourceIndex}">
      <td>${displayIndex + 1}</td><td>${classification}</td>${materialCells}
      <td><span class="preview-quantity">${item.quantity}</span></td><td>${field("positions", item.positions.join(","), true)}</td>
      <td class="status-cell">${statusMarkup(item)}</td><td class="operation-cell">${previewRowActions(item, editable)}</td></tr>`;
  }).join("");
  $("#confirm-conflicts").checked = confirmed && state.positionConflicts.length > 0;
  updatePreviewNextButton();
}

function renderPreviewSummary() {
  const ok = state.items.filter((item) => item.status === "ok" || item.status === "manual").length;
  const errors = state.items.filter(isItemError).length;
  const conflictCount = state.positionConflicts.length;
  const relationCount = state.classificationIssues.length;
  const totalQuantity = state.items.reduce((sum, item) => sum + item.quantity, 0);
  const ncPending = state.items.filter((item) => item.ncRequired && !item.ncDecision).length;
  const precisionPending = state.items.filter((item) => item.precisionSuggestion && !item.precisionDecision).length;
  $("#summary-grid").innerHTML = [
    ["合并后物料", state.items.length, ""],
    ["数量合计", totalQuantity, ""],
    ["已完成", ok, ""],
    ["待补充", errors, errors ? "warning" : ""],
    ["位号冲突", conflictCount, conflictCount ? "warning" : ""],
    ["分类待确认", relationCount, relationCount ? "warning" : ""],
  ].map(([label, value, cls]) => `<div class="metric ${cls}"><small>${label}</small><strong>${value}</strong></div>`).join("");
  const messages = [];
  if (errors) messages.push(`有 ${errors} 项物料需要人工补充，导出时会以红色醒目标记。`);
  const quantityMismatches = state.items.filter((item) => item.quantityMismatch);
  if (quantityMismatches.length) messages.push(`有 ${quantityMismatches.length} 项原始 Quantity 与位号数量不一致，输出数量仍按位号重新计算。`);
  if (conflictCount) messages.push(`发现 ${conflictCount} 个跨编码位号冲突：${state.positionConflicts.map((entry) => `${entry.position}（${entry.codes.join(" / ")}）`).join("；")}。`);
  if (relationCount) messages.push(`有 ${relationCount} 个“A类备选”尚未关联“A类主选”。`);
  if (ncPending) messages.push(`有 ${ncPending} 项带 NC 标记，请确认是空贴还是正常贴装。`);
  if (precisionPending) messages.push(`有 ${precisionPending} 项存在同阻值、更高精度物料，请确认是否合并。`);
  if (!messages.length) messages.push("所有项目均已核对完成，可以进入编审批信息填写。");
  $("#notice").textContent = messages.join(" ");
  const allRowsConfirmed = conflictCount > 0 && conflictRowsConfirmed();
  $("#conflict-confirm").classList.toggle("hidden", !conflictCount || allRowsConfirmed);
}

function statusMarkup(item) {
  const hasConflict = item.conflictingPositions.length > 0;
  const conflictConfirmed = hasConflict && item.confirmedConflictSignature === itemConflictSignature(item);
  const pendingModified = item.forceEdit && itemChangedFromInitial(item);
  const status = item.status === "model_ambiguous" ? "! 型号对应多个编码" : item.status === "model_missing" ? "! 规格型号未匹配" : item.status === "format" ? "! 编码格式错误" : item.status === "missing" ? "! 物料库未找到" : item.quantityMismatch && !item.quantityConfirmed ? "⚠ 数量待确认" : hasConflict && !conflictConfirmed ? "⚠ 位号冲突" : pendingModified ? "✎ 修改待确认" : item.userModified ? "✎ 用户已修改" : conflictConfirmed ? "✓ 冲突已确认" : item.status === "manual" ? "✎ 人工补全" : "✓ 已匹配";
  const statusClass = isItemError(item) ? "error" : pendingModified ? "pending" : item.userModified ? "modified" : hasConflict || (item.quantityMismatch && !item.quantityConfirmed) || item.status === "manual" ? "warning" : "";
  const conflict = item.conflictingPositions.length && !conflictConfirmed ? `<span class="tag warning">位号冲突：${escapeHtml(item.conflictingPositions.join(", "))}</span>` : "";
  const relation = item.classificationIssue ? `<span class="tag error">${item.classificationIssue}</span>` : "";
  const quantity = item.quantityMismatch && !item.quantityConfirmed ? `<span class="tag warning">原数量 ${escapeHtml(item.sourceQuantity)} / 位号 ${item.quantity}</span>` : "";
  const showSourceModel = item.sourceType === "bom" && (isItemError(item) || (item.bulkParsed && !item.bulkConfirmed));
  const source = showSourceModel ? `<button type="button" class="tag warning source-ggxh" data-action="copy-source-model" title="点击复制待查询规格型号"><small>待查询 GGXH</small><strong>${escapeHtml(item.sourceModel)}</strong><em>点击复制</em></button>` : "";
  const nc = item.ncRequired && !item.ncDecision
    ? `<span class="tag warning">NC 待确认：是否空贴</span><span class="inline-decisions"><button type="button" data-action="nc-empty">空贴</button><button type="button" data-action="nc-place">正常贴装</button></span>`
    : "";
  const precision = item.precisionSuggestion
    ? item.precisionDecision === "keep" ? ""
      : `<span class="tag warning">有更高精度物料：${escapeHtml(item.precisionSuggestion.targetModel)}</span><span class="inline-decisions"><button type="button" data-action="merge-precision">合并到高精度</button><button type="button" data-action="keep-precision">分别保留</button></span>`
    : "";
  return `<span class="tag ${statusClass}">${status}</span> ${conflict} ${relation} ${quantity} ${source} ${nc} ${precision}`;
}

function isItemError(item) {
  return ["format", "missing", "model_missing", "model_ambiguous"].includes(item.status);
}

function issueRank(item) {
  if (item.ncRequired && !item.ncDecision) return -1;
  if (item.quantityMismatch && !item.quantityConfirmed) return 0;
  if (item.precisionSuggestion && !item.precisionDecision) return 0;
  if (isItemError(item)) return 0;
  if (item.conflictingPositions.length && item.confirmedConflictSignature !== itemConflictSignature(item)) return 0;
  if (item.forceEdit && itemChangedFromInitial(item) && item.classification !== "A类备选") return 0;
  if (item.userModified) return 2;
  if (item.conflictingPositions.length && item.confirmedConflictSignature === itemConflictSignature(item)) return 1;
  if (item.status === "manual") return 3;
  return 4;
}

function applyPreviewEditsAndRecheck(rerender = true, notify = false) {
  const editedItems = [...state.items];
  [...$("#preview-body").querySelectorAll("tr")].forEach((row) => {
    const sourceIndex = Number(row.dataset.sourceIndex);
    const previous = state.items[sourceIndex];
    const value = (field, fallback = "") => row.querySelector(`[data-field="${field}"]`)?.value.trim() ?? fallback;
    if (!row.querySelector("[data-field]")) return;
    const code = value("code").replace(/\s/g, "");
    const codeChanged = code !== previous.code;
    const preserveOrClear = (field) => {
      const editedValue = value(field);
      return codeChanged && editedValue === previous[field] ? "" : editedValue;
    };
    const edited = {
      ...previous,
      confirmedConflictSignature: "",
      classification: value("classification", previous.classification) || "B类",
      linkedMainCode: value("linkedMainCode", previous.linkedMainCode),
      code,
      name: preserveOrClear("name"),
      model: preserveOrClear("model"),
      package: preserveOrClear("package"),
      positions: splitPositions(value("positions", previous.positions.join(","))),
    };
    edited.forceEdit = Boolean(previous.forceEdit || editableSnapshot(edited) !== editableSnapshot(previous));
    editedItems[sourceIndex] = edited;
  });
  state.items = editedItems;
  state.confirmedConflictSignature = "";
  $("#confirm-conflicts").checked = false;
  validateItems(state.items);
  state.outputBuffer = null;
  if (!rerender) {
    [...$("#preview-body").querySelectorAll("tr")].forEach((row) => {
      const item = state.items[Number(row.dataset.sourceIndex)];
      row.querySelector(".preview-quantity").textContent = item.quantity;
      row.className = [
        isItemError(item) || item.classificationIssue ? "error-row" : item.conflictingPositions.length || (item.quantityMismatch && !item.quantityConfirmed) || (item.ncRequired && !item.ncDecision) || (item.precisionSuggestion && !item.precisionDecision) ? "warning-row" : "",
        item.userModified ? "modified-row" : "",
        isPreviewItemEditable(item) ? "editing-row" : "",
        isThroughHoleComponent(item) ? "through-hole-row" : "",
        item.classification === "A类主选" ? "relation-main-row" : item.classification === "A类备选" ? "relation-backup-row" : "",
      ].filter(Boolean).join(" ");
      const shouldBeReadOnly = !item.forceEdit && !isItemError(item) && !item.conflictingPositions.length && !item.classificationIssue;
      if (shouldBeReadOnly && row.querySelector("[data-field]")) makePreviewRowReadOnly(row, item);
      const cell = row.querySelector(".status-cell");
      cell.innerHTML = statusMarkup(item);
      row.querySelector(".operation-cell").innerHTML = previewRowActions(item, isPreviewItemEditable(item));
    });
    renderPreviewSummary();
    updatePreviewNextButton();
    $("#live-check-status").textContent = "已实时复检";
    return;
  }
  const merged = new Map();
  state.items.forEach((item, index) => {
    const key = item.code || `__blank_${index}`;
    if (!merged.has(key)) merged.set(key, { ...item, positions: [...item.positions] });
    else {
      const target = merged.get(key);
      target.positions = [...new Set([...target.positions, ...item.positions])];
      target.name = target.name || item.name;
      target.model = target.model || item.model;
      target.package = target.package || item.package;
    }
  });
  state.items = [...merged.values()];
  validateItems(state.items);
  state.outputBuffer = null;
  renderPreview();
  $("#live-check-status").textContent = "已重新检查";
  if (notify) toast("已应用修改，并重新完成查库、格式和位号冲突检查。");
}

function makePreviewRowReadOnly(row, item) {
  const readonly = (value) => `<span class="preview-readonly">${escapeHtml(value || "—")}</span>`;
  row.children[1].innerHTML = `${readonly(item.classification)}${item.classification === "A类备选" ? `<small class="relation-note">关联：${escapeHtml(item.linkedMainCode)}</small>` : ""}`;
  row.children[2].innerHTML = readonly(item.code);
  row.children[3].innerHTML = readonly(item.name);
  row.children[4].innerHTML = readonly(item.model);
  row.children[5].innerHTML = readonly(item.package);
  row.children[7].innerHTML = readonly(item.positions.join(","));
  row.querySelector(".status-cell").innerHTML = statusMarkup(item);
  row.querySelector(".operation-cell").innerHTML = previewRowActions(item, false);
}

function previewRowActions(item, editable) {
  const retry = item.bulkParsed && !item.bulkConfirmed ? `<button type="button" class="row-edit-button retry-material-button" data-action="retry-material-line">重新粘贴</button>` : "";
  return `<div class="row-actions"><button type="button" class="row-edit-button copy-row-button" data-action="copy-row">复制</button><button type="button" class="row-edit-button" data-action="${editable ? "finish-row" : "edit-row"}" title="${editable ? "完成并确认本行修改" : "修改本行"}">${editable ? "确认" : "修改"}</button>${retry}<button type="button" class="row-edit-button delete-row-button" data-action="delete-row">删除</button></div>`;
}

function parseMaterialLine(value) {
  const text = String(value || "").trim();
  const codeMatch = text.match(/(?:^|\s)(\d{12})(?=\s|$)/);
  if (!codeMatch) throw new Error("没有识别到12位编码");
  const code = codeMatch[1];
  const afterCode = text.slice((codeMatch.index || 0) + codeMatch[0].length).trim();
  const tabParts = afterCode.split(/\t+/).map((part) => part.trim()).filter(Boolean);
  let name;
  let model;
  let packageName;
  if (tabParts.length >= 3) {
    [name, ...model] = tabParts.slice(0, -1);
    packageName = tabParts.at(-1);
    model = model.join(" ");
  } else {
    const parts = afterCode.split(/\s+/).filter(Boolean);
    if (parts.length < 3) throw new Error("请按“编码 名称 规格型号 封装”粘贴完整数据");
    name = parts.shift();
    packageName = parts.pop();
    model = parts.join(" ");
  }
  if (!name || !model || !packageName) throw new Error("物料名称、规格型号或封装缺失");
  return { code, name, model, package: packageName };
}

function isPreviewItemEditable(item) {
  const isError = isItemError(item);
  const conflictConfirmed = Boolean(item.conflictingPositions.length && item.confirmedConflictSignature === itemConflictSignature(item));
  return Boolean(item.forceEdit || isError || (item.quantityMismatch && !item.quantityConfirmed) || (item.conflictingPositions.length && !conflictConfirmed) || item.classificationIssue);
}

async function copyPreviewRow(row, item) {
  const currentValue = (field) => row.querySelector(`[data-field="${field}"]`)?.value.trim() ?? item[field] ?? "";
  const text = [currentValue("code"), currentValue("name"), currentValue("model"), currentValue("package")].join("\t");
  await writeClipboardText(text);
  toast("已复制编码、物料名称、规格型号和封装。");
}

async function writeClipboardText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
}

async function handlePreviewAction(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const row = button.closest("tr");
  const sourceIndex = Number(row.dataset.sourceIndex);
  const item = state.items[sourceIndex];
  if (button.dataset.action === "copy-source-model") {
    await writeClipboardText(item.sourceModel || item.model || "");
    return toast(`已复制待查询 GGXH：${item.sourceModel || item.model || ""}`);
  }
  if (button.dataset.action === "parse-material-line") {
    try {
      const bulkInput = row.querySelector("[data-material-line]")?.value || "";
      const record = parseMaterialLine(bulkInput);
      Object.assign(item, record, { bulkInput, bulkParsed: true, bulkConfirmed: false, forceEdit: true });
      validateItems(state.items);
      state.outputBuffer = null;
      renderPreview();
      return toast("已识别物料并填入对应列，请核对后点击“确认”。");
    } catch (error) {
      return toast(error.message);
    }
  }
  if (button.dataset.action === "retry-material-line") {
    Object.assign(item, {
      code: "", name: "", model: item.sourceModel || "", package: "",
      matchCandidates: [], bulkParsed: false, bulkConfirmed: false, forceEdit: true,
    });
    validateItems(state.items);
    state.outputBuffer = null;
    renderPreview();
    return toast("已退回整行粘贴模式，可修改后重新识别。");
  }
  if (button.dataset.action === "nc-empty") {
    state.deletedPreviewIds.add(item.previewId);
    state.deletedReasons.set(item.previewId, "用户确认 NC 物料空贴，已自动从输出中删除");
    state.items = state.items.filter((candidate) => candidate !== item);
    validateItems(state.items);
    state.outputBuffer = null;
    renderPreview();
    return toast("已确认空贴，该物料已从输出中删除，并记入修改明细。");
  }
  if (button.dataset.action === "nc-place") {
    item.ncDecision = "place";
    item.userModified = true;
    renderPreview();
    return toast("已确认该物料正常贴装。");
  }
  if (button.dataset.action === "keep-precision") {
    item.precisionDecision = "keep";
    item.userModified = true;
    renderPreview();
    return toast("已确认分别保留两种精度的物料。");
  }
  if (button.dataset.action === "merge-precision") {
    const targetId = item.precisionSuggestion?.targetPreviewId;
    const target = state.items.find((candidate) => candidate.previewId === targetId);
    if (!target) return toast("未找到对应的高精度物料，请重新检查。 ");
    target.positions = [...new Set([...target.positions, ...item.positions])];
    target.userModified = true;
    state.deletedPreviewIds.add(item.previewId);
    state.items = state.items.filter((candidate) => candidate !== item);
    validateItems(state.items);
    state.outputBuffer = null;
    renderPreview();
    return toast(`已合并到高精度物料 ${target.model || target.sourceModel}。`);
  }
  if (button.dataset.action === "copy-row") return copyPreviewRow(row, item);
  if (button.dataset.action === "delete-row") {
    const previewId = item.previewId;
    if (!window.confirm(`确认删除编码“${item.code || "未填写"}”这一行吗？`)) return;
    applyPreviewEditsAndRecheck(false, false);
    state.items = state.items.filter((current) => current.previewId !== previewId);
    state.deletedPreviewIds.add(previewId);
    state.deletedReasons.set(previewId, "用户手动删除该行");
    state.confirmedConflictSignature = "";
    validateItems(state.items);
    state.outputBuffer = null;
    renderPreview();
    toast("该行已从本次输出中删除。");
    return;
  }
  if (button.dataset.action === "edit-row") {
    item.forceEdit = true;
    item.editBaseline = editableSnapshot(item);
  } else {
    const original = state.previewBaseline.get(item.previewId);
    const baseline = item.editBaseline || (original ? JSON.stringify(original) : editableSnapshot(item));
    applyPreviewEditsAndRecheck(false, false);
    const current = state.items[sourceIndex];
    if (/^\d{12}$/.test(current.code) && current.name && current.model && current.package) {
      const record = { code: current.code, name: current.name, model: current.model, package: current.package };
      try {
        await upsertIndexedMaterial(record);
        current.status = "ok";
        current.matchCandidates = [current.code];
        current.bulkConfirmed = true;
      } catch (error) {
        console.error(error);
        return toast("本行已填写，但追加到本地物料库失败，请重试确认。");
      }
    }
    current.forceEdit = false;
    const originalCurrent = state.previewBaseline.get(current.previewId);
    const initialSnapshot = originalCurrent ? JSON.stringify(originalCurrent) : baseline;
    current.userModified = editableSnapshot(current) !== initialSnapshot;
    if (current.conflictingPositions.length) {
      current.confirmedConflictSignature = itemConflictSignature(current);
      current.userModified = true;
    }
    if (current.quantityMismatch) {
      current.quantityConfirmed = true;
      current.userModified = true;
    }
    delete current.editBaseline;
  }
  renderPreview();
}

function previewCanProceed() {
  return state.items.length > 0 && previewPendingItems().length === 0;
}

function previewPendingItems() {
  return state.items.filter((item) => {
    if (isItemError(item) || item.forceEdit || item.classificationIssue) return true;
    if (item.ncRequired && !item.ncDecision) return true;
    if (item.quantityMismatch && !item.quantityConfirmed) return true;
    if (item.precisionSuggestion && !item.precisionDecision) return true;
    if (item.conflictingPositions.length && item.confirmedConflictSignature !== itemConflictSignature(item)) return true;
    return item.status !== "ok" && !item.userModified;
  });
}

function updatePreviewNextButton() {
  const button = $("#to-step-3");
  const blocked = !previewCanProceed();
  button.disabled = false;
  button.classList.toggle("is-blocked", blocked);
  button.setAttribute("aria-disabled", String(blocked));
  button.title = blocked ? "请先完成所有待确认项目" : "进入编审批信息填写";
}
function conflictSignature() {
  return state.positionConflicts.map((entry) => `${entry.position.toUpperCase()}:${[...(entry.owners || entry.codes)].sort().join("|")}`).sort().join(";");
}
function itemConflictSignature(item) {
  return (item.conflictingPositions || []).map((position) => {
    const conflict = state.positionConflicts.find((entry) => entry.position.toUpperCase() === position.toUpperCase());
    return `${position.toUpperCase()}:${[...(conflict?.owners || conflict?.codes || [])].sort().join("|")}`;
  }).sort().join(";");
}
function conflictRowsConfirmed() {
  return state.items.filter((item) => item.conflictingPositions.length).every((item) => item.confirmedConflictSignature === itemConflictSignature(item));
}
function editableSnapshot(item) {
  return JSON.stringify(previewComparable(item));
}
function itemChangedFromInitial(item) {
  const original = state.previewBaseline.get(item.previewId);
  return Boolean(original && editableSnapshot(item) !== JSON.stringify(original));
}
function previewComparable(item) {
  return {
    classification: item.classification || "B类",
    linkedMainCode: item.linkedMainCode || "",
    code: item.code || "",
    name: item.name || "",
    model: item.model || "",
    package: item.package || "",
    positions: [...(item.positions || [])],
    ncDecision: item.ncDecision || "",
    precisionDecision: item.precisionDecision || "",
  };
}
function renderMetadataChangeSummary() {
  const fieldLabels = {
    classification: "物资分类", linkedMainCode: "关联主选", code: "12位编码",
    name: "物料名称", model: "规格型号", package: "封装", positions: "位号清单",
  };
  const formatValue = (key, value) => key === "positions" ? (value || []).join(", ") : String(value || "（空）");
  const changes = [];
  const currentIds = new Set();
  state.items.forEach((item) => {
    currentIds.add(item.previewId);
    const before = state.previewBaseline.get(item.previewId);
    const after = previewComparable(item);
    if (!before) {
      changes.push({ item, before: null, after, changedKeys: Object.keys(fieldLabels), details: ["新增物料行"] });
      return;
    }
    const changedKeys = Object.keys(fieldLabels).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    const details = changedKeys.map((key) => `${fieldLabels[key]}：${formatValue(key, before[key])} → ${formatValue(key, after[key])}`);
    if (item.confirmedConflictSignature) details.push(`已确认位号冲突：${item.conflictingPositions.join(", ")}`);
    if (details.length) changes.push({ item, before, after, changedKeys, details });
  });
  state.previewBaseline.forEach((before, id) => {
    if (!currentIds.has(id)) {
      const deleted = state.deletedPreviewIds.has(id);
      changes.push({ item: null, before, after: before, changedKeys: [], deleted, details: [deleted ? (state.deletedReasons.get(id) || "用户已删除该行") : "该行已合并到相同编码的物料中"] });
    }
  });
  const renderCell = (change, key) => {
    const changed = change.changedKeys.includes(key);
    const current = formatValue(key, change.after[key]);
    if (!changed) return `<td>${escapeHtml(current)}</td>`;
    const previous = change.before ? formatValue(key, change.before[key]) : "（新增）";
    return `<td class="changed-cell"><small>原：${escapeHtml(previous)}</small><strong>${escapeHtml(current)}</strong></td>`;
  };
  const container = $("#preview-change-summary");
  container.innerHTML = changes.length
    ? `<div class="change-summary-head"><strong>预览修改明细</strong><span>共 ${changes.length} 行</span></div><table class="change-table"><thead><tr><th>#</th><th>物资分类</th><th>12位编码</th><th>物料名称</th><th>规格型号</th><th>封装</th><th>数量</th><th>位号清单</th><th>状态</th><th>修改说明</th></tr></thead><tbody>${changes.map((change, index) => {
      const item = change.item;
      const classification = change.after.classification === "A类备选" && change.after.linkedMainCode ? `${change.after.classification}\n关联：${change.after.linkedMainCode}` : change.after.classification;
      const status = !item ? `<span class="tag ${change.deleted ? "error" : "warning"}">${change.deleted ? "用户已删除" : "已合并"}</span>` : statusMarkup(item);
      return `<tr><td>${index + 1}</td><td>${escapeHtml(classification)}</td>${renderCell(change, "code")}${renderCell(change, "name")}${renderCell(change, "model")}${renderCell(change, "package")}<td>${item?.quantity ?? change.after.positions.length}</td>${renderCell(change, "positions")}<td>${status}</td><td class="change-notes">${change.details.map((detail) => `<div>${escapeHtml(detail)}</div>`).join("")}</td></tr>`;
    }).join("")}</tbody></table>`
    : `<div class="change-summary-head"><strong>预览修改明细</strong><span>未修改任何内容</span></div>`;
}
function updateMetadataSubmitState() { $("#download-button").disabled = !$("#metadata-form").checkValidity(); }
function debounce(callback, delay) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => callback(...args), delay); }; }

async function downloadOutput() {
  const button = $("#download-button");
  button.disabled = true;
  button.firstChild.textContent = "正在生成… ";
  try {
    if (!state.outputBuffer) await buildOutputWorkbook();
    const blob = new Blob([state.outputBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = state.outputName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast("BOM 表已生成");
  } catch (error) {
    console.error(error);
    const reason = friendlyExportError(error);
    toast(`生成失败：${reason}`);
  } finally {
    button.firstChild.textContent = "生成并下载 Excel ";
    updateMetadataSubmitState();
  }
}

async function buildOutputWorkbook() {
  if (window.location.protocol === "file:") {
    throw new Error("LOCAL_FILE_MODE");
  }
  const response = await fetch(`template.xlsx?v=20260816-5`, { cache: "no-store" });
  if (!response.ok) throw new Error("输出模板加载失败。");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await response.arrayBuffer());
  updateComponentSheet(workbook);
  updateHistorySheet(workbook);
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.calcProperties.forceFullCalc = true;
  state.outputBuffer = await workbook.xlsx.writeBuffer();
  state.outputName = `${buildOutputBaseName()}.xlsx`;
}

function buildOutputBaseName() {
  const compactDate = dateCompact($("#record-date").value);
  let baseName = (state.sourceFile?.name || "元件清单").replace(/\.(bom|xlsx|xlsm)$/i, "");
  baseName = baseName.replace(/(?:_\d{8})+$/, "");
  baseName = /V\d+(?:[._]\d+)+/i.test(baseName)
    ? baseName.replace(/V\d+(?:[._]\d+)+/i, state.sourceMeta.nextVersion)
    : `${baseName}_${state.sourceMeta.nextVersion}`;
  return `${baseName}_${compactDate}`;
}

function friendlyExportError(error) {
  const message = String(error?.message || error || "未知错误");
  if (message.includes("LOCAL_FILE_MODE")) return "当前是 file:// 直接打开模式，浏览器无法读取输出模板。请通过 GitHub Pages 或 http://127.0.0.1 访问。";
  if (message.includes("输出模板加载失败")) return "未能加载 template.xlsx，请刷新页面后重试。";
  if (message.includes("Shared Formula")) return "模板中存在损坏的共享公式引用。";
  return message.length > 140 ? `${message.slice(0, 140)}…` : message;
}

function updateComponentSheet(workbook) {
  const sheet = workbook.getWorksheet("元件清单");
  if (!sheet) throw new Error("输出模板缺少“元件清单”工作表。");
  const exemplar = captureRow(sheet, 6, 10);
  if (sheet.rowCount >= 6) sheet.spliceRows(6, sheet.rowCount - 5);
  const exportItems = orderItemsForExport(state.items);
  const exportSequences = buildExportSequences(exportItems);
  sheet.getCell("D1").font = { ...(sheet.getCell("D1").font || {}), size: 14, bold: true };
  for (let rowNumber = 1; rowNumber <= 4; rowNumber += 1) {
    for (let column = 1; column <= 10; column += 1) {
      if (rowNumber === 1 && column === 4) continue;
      const cell = sheet.getCell(rowNumber, column);
      if (cell.value != null) cell.font = { ...(cell.font || {}), size: 11 };
    }
  }
  for (let column = 1; column <= 10; column += 1) {
    sheet.getCell(5, column).font = { ...(sheet.getCell(5, column).font || {}), size: 11, bold: true };
  }
  const rows = exportItems.length + 1;
  for (let index = 0; index < rows; index += 1) {
    sheet.insertRow(6 + index, []);
    restoreRow(sheet, 6 + index, exemplar);
  }
  exportItems.forEach((item, index) => {
    const row = sheet.getRow(6 + index);
    const rowNote = [
      item.status === "ok" ? "" : item.status === "manual" ? "人工补全" : statusMessage(item.status),
      item.ncDecision === "empty" ? "NC：用户确认空贴" : item.ncDecision === "place" ? "NC：用户确认正常贴装" : "",
      item.precisionDecision === "keep" ? "已确认与高精度物料分别保留" : "",
    ].filter(Boolean).join("；");
    row.values = [exportSequences[index], item.classification, item.code, item.name, item.model, item.package, null, item.positions.join(","), "", rowNote];
    restoreRow(sheet, 6 + index, exemplar, false);
    setQuantityFormula(row, item.quantity);
    for (let column = 1; column <= 10; column += 1) {
      row.getCell(column).font = { ...(row.getCell(column).font || {}), size: 12 };
    }
    if (isItemError(item)) {
      for (let column = 1; column <= 10; column += 1) {
        const cell = row.getCell(column);
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };
        cell.font = { ...(cell.font || {}), color: { argb: "FF9C0006" }, bold: column === 10 };
      }
    } else if (isThroughHoleComponent(item)) {
      for (let column = 1; column <= 10; column += 1) {
        sheet.getCell(row.number, column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };
      }
    }
  });
  const placeholder = sheet.getRow(6 + exportItems.length);
  placeholder.values = [(exportSequences.at(-1) || 0) + 1, "A类主选", "", "", "", "", "", "", "", "请手动填写整板信息"];
  restoreRow(sheet, placeholder.number, exemplar, false);
  setQuantityFormula(placeholder, 0);
  for (let column = 1; column <= 10; column += 1) {
    placeholder.getCell(column).font = { ...(placeholder.getCell(column).font || {}), size: 12 };
  }
  placeholder.getCell(10).font = { ...(placeholder.getCell(10).font || {}), color: { argb: "FF7F6000" }, italic: true };
  // ExcelJS 会在插入行时保留原模板的共享公式克隆，需要显式清除有效区域之后的残留单元格。
  for (let rowNumber = placeholder.number + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    sheet.getRow(rowNumber).values = [];
  }
  mergeConfirmedMainBackupRows(sheet, exportItems, 6);
  applyComponentSheetLayout(sheet, 6, exportItems.length + 1);
  sheet.getCell("D1").value = buildOutputBaseName();
}

function applyComponentSheetLayout(sheet, firstRow, rowCount) {
  const widths = [7, 11, 17, 18, 30, 11, 8, 38, 14, 14];
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.views = [{ state: "normal", zoomScale: 80, zoomScaleNormal: 80, showGridLines: true }];
  sheet.getRow(5).height = 26;
  const wrappedColumns = [
    { column: 4, width: widths[3] },
    { column: 5, width: widths[4] },
    { column: 6, width: widths[5] },
    { column: 8, width: widths[7] },
    { column: 9, width: widths[8] },
    { column: 10, width: widths[9] },
  ];
  for (let rowNumber = firstRow; rowNumber < firstRow + rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    let requiredLines = 1;
    for (let column = 1; column <= 10; column += 1) {
      row.getCell(column).alignment = { ...(row.getCell(column).alignment || {}), vertical: "middle", wrapText: true };
    }
    wrappedColumns.forEach(({ column, width }) => {
      const value = String(row.getCell(column).text || row.getCell(column).value || "");
      const explicitLines = value.split(/\r?\n/);
      const lines = explicitLines.reduce((sum, line) => sum + Math.max(1, Math.ceil(visualTextLength(line) / Math.max(4, width - 2))), 0);
      requiredLines = Math.max(requiredLines, lines);
    });
    row.height = Math.min(120, Math.max(25, requiredLines * 17));
  }
}

function visualTextLength(text) {
  return [...String(text || "")].reduce((length, character) => length + (/[^\x00-\xff]/.test(character) ? 1.7 : 1), 0);
}

function buildExportSequences(items) {
  let sequence = 0;
  return items.map((item, index) => {
    const previous = items[index - 1];
    if (item.classification === "A类备选" && previous && isConfirmedMainBackupPair(previous, item)) return sequence;
    sequence += 1;
    return sequence;
  });
}

function mergeConfirmedMainBackupRows(sheet, items, firstRow) {
  for (let index = 0; index < items.length - 1; index += 1) {
    const main = items[index];
    const backup = items[index + 1];
    if (!isConfirmedMainBackupPair(main, backup)) continue;
    const topRow = firstRow + index;
    const bottomRow = topRow + 1;
    [1, 7, 8].forEach((column) => sheet.mergeCells(topRow, column, bottomRow, column));
    if (String(main.package || "") === String(backup.package || "")) sheet.mergeCells(topRow, 6, bottomRow, 6);
    [1, 6, 7].forEach((column) => {
      sheet.getCell(topRow, column).alignment = { ...(sheet.getCell(topRow, column).alignment || {}), horizontal: "center", vertical: "middle", wrapText: true };
    });
    sheet.getCell(topRow, 8).alignment = { ...(sheet.getCell(topRow, 8).alignment || {}), vertical: "middle", wrapText: true };
    index += 1;
  }
}

function isConfirmedMainBackupPair(main, backup) {
  if (main.classification !== "A类主选" || backup.classification !== "A类备选" || backup.linkedMainCode !== main.code) return false;
  const mainPositions = canonicalPositions(main.positions);
  const backupPositions = canonicalPositions(backup.positions);
  if (!mainPositions || mainPositions !== backupPositions) return false;
  const globallyConfirmed = Boolean(state.positionConflicts.length && state.confirmedConflictSignature === conflictSignature());
  const rowsConfirmed = [main, backup].every((item) => item.confirmedConflictSignature && item.confirmedConflictSignature === itemConflictSignature(item));
  return globallyConfirmed || rowsConfirmed;
}

function canonicalPositions(positions) {
  return (positions || []).map((position) => String(position).trim().toUpperCase()).filter(Boolean).sort().join(",");
}

function orderItemsForExport(items) {
  const backups = items.filter((item) => item.classification === "A类备选");
  const ordered = [];
  const primaryItems = items.filter((item) => item.classification !== "A类备选").map((item, originalIndex) => ({ item, originalIndex }));
  primaryItems.sort((left, right) => componentCategory(left.item) - componentCategory(right.item)
    || componentSequence(left.item) - componentSequence(right.item)
    || left.originalIndex - right.originalIndex);
  primaryItems.forEach(({ item }) => {
    ordered.push(item);
    if (item.classification === "A类主选") ordered.push(...backups.filter((backup) => backup.linkedMainCode === item.code));
  });
  ordered.push(...backups.filter((backup) => !ordered.includes(backup)));
  return ordered;
}

function componentCategory(item) {
  const prefix = String(item.positions?.[0] || "").match(/^[A-Za-z]+/)?.[0]?.toUpperCase() || "";
  const text = `${item.name || ""} ${item.model || ""} ${item.package || ""}`;
  if (prefix === "C" || /电容/.test(text)) return 0;
  if (prefix === "R" || /电阻/.test(text)) return 1;
  if (["L", "FB"].includes(prefix) || /电感|磁珠|扼流圈/.test(text)) return 2;
  if (["Q", "VT"].includes(prefix) || /三极管|晶体管|MOS管|场效应管/i.test(text)) return 3;
  if (["D", "VD"].includes(prefix) || /二极管|整流管|稳压管|发光管|LED/i.test(text)) return 4;
  if (["U", "IC"].includes(prefix) || /芯片|集成电路|处理器|存储器|MCU|IC\b/i.test(text)) return 5;
  if (["J", "CN", "P", "X"].includes(prefix) || /插座|连接器|卡座|接插件|端子座/.test(text)) return 99;
  return 7;
}

function componentSequence(item) {
  const numbers = (item.positions || []).map((position) => Number(String(position).match(/\d+/)?.[0])).filter(Number.isFinite);
  return numbers.length ? Math.min(...numbers) : Number.MAX_SAFE_INTEGER;
}

function isThroughHoleComponent(item) {
  const nameAndModel = `${item.name || ""} ${item.model || ""}`;
  const packageText = String(item.package || "");
  const allText = `${nameAndModel} ${packageText}`;
  const isAluminumElectrolytic = /铝电解|铝质电解|电解电容/i.test(nameAndModel);
  const explicitlyThroughHole = /直插|插件|径向|引线|卧式|立式|RADIAL|DIP|THT/i.test(allText);
  const throughHoleDimensions = !/贴片|SMD|SMT/i.test(allText) && /(?:φ|Φ)?\d+(?:\.\d+)?\s*(?:mm)?\s*[×*xX]\s*\d+(?:\.\d+)?\s*(?:mm)?/i.test(`${packageText} ${item.model || ""}`);
  return explicitlyThroughHole || (isAluminumElectrolytic && throughHoleDimensions);
}

function setQuantityFormula(row, result) {
  const positionCell = `H${row.number}`;
  row.getCell(7).value = {
    formula: `IF(TRIM(${positionCell})="",0,LEN(${positionCell})-LEN(SUBSTITUTE(SUBSTITUTE(${positionCell},",",""),"，",""))+1)`,
    result,
  };
}

function updateHistorySheet(workbook) {
  const sheet = workbook.getWorksheet("清单更新记录");
  if (!sheet) throw new Error("输出模板缺少“清单更新记录”工作表。");
  const styles = [captureRow(sheet, 3, 8), captureRow(sheet, 4, 8), captureRow(sheet, 5, 8)];
  const noteStyle = captureRow(sheet, Math.max(6, sheet.rowCount), 8);
  const templateMeta = readSourceMetadata(workbook);
  const names = {
    compile: $("#compile-name").value.trim() || state.sourceMeta.names.compile || templateMeta.names.compile,
    review: $("#review-name").value.trim() || state.sourceMeta.names.review || templateMeta.names.review,
    approve: $("#approve-name").value.trim() || state.sourceMeta.names.approve || templateMeta.names.approve,
  };
  const approvalDate = dateCompact($("#record-date").value);
  const newRecord = {
    sequence: Math.max(0, ...state.sourceMeta.history.map((record) => Number(record.sequence) || 0)) + 1,
    version: state.sourceMeta.nextVersion,
    date: dateCompact($("#record-date").value),
    note: $("#change-note").value.trim(),
    compile: `编制：${names.compile}${approvalDate}`,
    review: `审核：${names.review}${approvalDate}`,
    approve: `批准：${names.approve}${approvalDate}`,
  };
  const records = [newRecord, ...state.sourceMeta.history];
  const mergeRanges = [...(sheet.model.merges || [])];
  mergeRanges.filter((range) => Number(range.match(/\d+/)?.[0]) >= 3).forEach((range) => {
    try { sheet.unMergeCells(range); } catch (_) { /* already unmerged */ }
  });
  const rebuiltRowCount = records.length * 3 + 1;
  const replacementRows = Array.from({ length: rebuiltRowCount }, () => []);
  sheet.spliceRows(3, Math.max(0, sheet.rowCount - 2), ...replacementRows);
  records.forEach((record, index) => {
    const start = 3 + index * 3;
    for (let offset = 0; offset < 3; offset += 1) {
      restoreRow(sheet, start + offset, styles[offset]);
    }
    sheet.getCell(start, 1).value = Number(record.sequence) || index + 1;
    sheet.getCell(start, 2).value = record.version;
    sheet.getCell(start, 3).value = Number(String(record.date).replace(/\D/g, "")) || record.date;
    sheet.getCell(start, 4).value = record.note;
    sheet.getCell(start, 8).value = record.compile;
    sheet.getCell(start + 1, 8).value = record.review;
    sheet.getCell(start + 2, 8).value = record.approve;
    sheet.mergeCells(start, 1, start + 2, 1);
    sheet.mergeCells(start, 2, start + 2, 2);
    sheet.mergeCells(start, 3, start + 2, 3);
    sheet.mergeCells(start, 4, start + 2, 7);
  });
  const noteRow = 3 + records.length * 3;
  restoreRow(sheet, noteRow, noteStyle);
  sheet.getCell(noteRow, 1).value = "备注：更新记录顺序为倒序。最新的记录写在最上面。";
  sheet.mergeCells(noteRow, 1, noteRow, 8);
  applyHistorySheetLayout(sheet, records.length, noteRow);
}

function applyHistorySheetLayout(sheet, recordCount, noteRow) {
  const widths = [8, 13, 14, 18, 18, 18, 18, 32];
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.views = [{ state: "normal", zoomScale: 90, zoomScaleNormal: 90, showGridLines: true }];
  sheet.getRow(1).height = 28;
  sheet.getRow(2).height = 25;
  for (let index = 0; index < recordCount; index += 1) {
    const start = 3 + index * 3;
    const note = String(sheet.getCell(start, 4).value || "");
    const noteLines = Math.max(1, Math.ceil(visualTextLength(note) / 64));
    const perRowHeight = Math.max(25, Math.min(42, Math.ceil(noteLines / 3) * 18));
    for (let offset = 0; offset < 3; offset += 1) {
      const row = sheet.getRow(start + offset);
      row.height = perRowHeight;
      for (let column = 1; column <= 8; column += 1) {
        const cell = row.getCell(column);
        cell.font = { ...(cell.font || {}), size: 11 };
        cell.alignment = { ...(cell.alignment || {}), vertical: "middle", wrapText: true };
      }
    }
  }
  sheet.getRow(noteRow).height = 25;
  sheet.getCell(noteRow, 1).font = { ...(sheet.getCell(noteRow, 1).font || {}), size: 11 };
  sheet.getCell(noteRow, 1).alignment = { ...(sheet.getCell(noteRow, 1).alignment || {}), vertical: "middle", wrapText: true };
}

function captureRow(sheet, rowNumber, columnCount) {
  const row = sheet.getRow(rowNumber);
  return {
    height: row.height,
    cells: Array.from({ length: columnCount }, (_, index) => {
      const cell = row.getCell(index + 1);
      return { style: clone(cell.style), numberFormat: cell.numFmt };
    }),
  };
}

function restoreRow(sheet, rowNumber, snapshot, restoreHeight = true) {
  const row = sheet.getRow(rowNumber);
  if (restoreHeight) row.height = snapshot.height;
  snapshot.cells.forEach((saved, index) => {
    row.getCell(index + 1).style = clone(saved.style) || {};
    if (saved.numberFormat) row.getCell(index + 1).numFmt = saved.numberFormat;
  });
}

function statusMessage(status) {
  if (status === "model_ambiguous") return "未完成填写：规格型号对应多个12位编码";
  if (status === "model_missing") return "未完成填写：规格型号在物料数据库中未匹配";
  return status === "format" ? "未完成填写：12位编码格式错误" : "未完成填写：物料数据库中未查到";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

let toastTimer;
function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  const text = String(message);
  const type = /(失败|错误|超过|未找到|请先|请选择|没有可导出)/.test(text)
    ? "error"
    : /(取消|冲突|检查|确认)/.test(text) ? "warning" : "success";
  element.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 4200);
}

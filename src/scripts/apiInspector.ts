import {
  listCustomTranslateModels,
  listGeminiModels,
  loadSavedGeminiSettings,
  loadSavedTranslateSettings,
  saveGeminiSettings,
  saveTranslateSettings,
  testTranslateApi,
} from "@/scripts/googleTranslateClient.ts"

type Protocol = "auto" | "openai" | "responses" | "anthropic"
type TestState = "ok" | "error"

type ApiModel = {
  id: string
  owned_by?: string
  display_name?: string
  supported_endpoint_types?: string[]
  score: number
  recommended: boolean
  testState?: TestState
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)

function modelScore(id: string) {
  const value = id.toLowerCase()
  if (/(embed|embedding|rerank|moderation|whisper|transcri|speech|tts|image|ocr|live)/.test(value)) {
    return -100
  }
  let score = 20
  if (/claude/.test(value)) score += 60
  if (/gpt-[5-9]|gpt-4\.[1-9]|gpt-4o/.test(value)) score += 58
  if (/gemini-(2\.[5-9]|[3-9])/.test(value)) score += 56
  if (/qwen3|deepseek|llama-4|mistral-large/.test(value)) score += 48
  if (/sonnet|pro|reason|thinking/.test(value)) score += 12
  if (/opus/.test(value)) score -= 12
  if (/free/.test(value)) score += 16
  if (/flash|haiku|mini|turbo/.test(value)) score += 8
  if (/vision|vl|audio|realtime/.test(value)) score -= 15
  return score
}

function normalizeModels(
  input: Array<{
    id: string
    owned_by?: string
    display_name?: string
    supported_endpoint_types?: string[]
  }>,
) {
  return input
    .map((model) => ({
      ...model,
      score: modelScore(model.id),
      recommended: false,
    }))
    .filter((model) => model.score >= 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((model, index) => ({ ...model, recommended: index < 5 })) as ApiModel[]
}

function endpointProtocol(value: string): Exclude<Protocol, "auto"> | undefined {
  try {
    const host = new URL(value).hostname.toLowerCase()
    if (host === "cc.freemodel.dev") return "anthropic"
    if (host === "api.freemodel.dev") return "responses"
  } catch {
    // Form validation reports malformed endpoints before a request is sent.
  }
  return undefined
}

function detectedProtocol(
  model: ApiModel | undefined,
  endpoint = "",
  selected: Protocol = "auto",
): Exclude<Protocol, "auto"> {
  const providerRoute = endpointProtocol(endpoint)
  if (providerRoute) return providerRoute
  if (selected !== "auto") return selected
  const types = (model?.supported_endpoint_types || []).map((type) => type.toLowerCase())
  if (types.includes("anthropic")) return "anthropic"
  if (types.includes("responses") || types.includes("openai-responses")) return "responses"
  if (types.includes("openai") || types.includes("openai-chat")) return "openai"
  if (model?.owned_by?.toLowerCase() === "anthropic" || /claude/i.test(model?.id || "")) {
    return "anthropic"
  }
  return "openai"
}

function protocolLabel(value: string | undefined) {
  if (value === "anthropic") return "Anthropic Messages"
  if (value === "responses") return "OpenAI Responses"
  if (value === "openai") return "OpenAI Chat Completions"
  return value || "tự động"
}

function friendlyError(error: unknown, model = "", endpoint = "") {
  const message = String((error as Error)?.message || error)
  if (/HTTP\s*403|tier is insufficient|insufficient.*tier|permission denied/i.test(message)) {
    if (/freemodel\.dev/i.test(endpoint)) {
      return `${model || "Model"} bị FreeModel từ chối (HTTP 403). Endpoint và route đã đúng, nhưng credit Tier 0 có thể chỉ cho Claude Code/Codex CLI; Subvid là ứng dụng API độc lập nên vẫn có thể bị chặn. Hãy kiểm tra quyền API trên dashboard hoặc dùng Gemini/model có quyền API trực tiếp.`
    }
    return `${model || "Model"} bị nhà cung cấp từ chối (HTTP 403). Model có thể vẫn xuất hiện trong danh sách, nhưng gói/quota hoặc loại request của tài khoản không được phép. Subvid đã chọn route theo endpoint; hãy thử model khác hoặc kiểm tra quyền trên dashboard.`
  }
  if (/HTTP\s*401|unauthorized|unauthenticated|invalid.*key|API key not valid/i.test(message)) {
    return "API key không hợp lệ, đã bị tắt hoặc không thuộc nhà cung cấp này (HTTP 401)."
  }
  if (/HTTP\s*429|quota|rate.?limit|resource_exhausted/i.test(message)) {
    return "API đã chạm giới hạn tần suất hoặc quota (HTTP 429). Hãy chờ quota hồi phục hoặc chọn model khác."
  }
  return message
}

export function createApiInspectorController() {
  const app = $("#app")
  const inspector = $("#api-inspector")
  const subtitleTab = $<HTMLButtonElement>("#nav-subtitle-tool")
  const apiTab = $<HTMLButtonElement>("#nav-api-tool")
  const customTab = $<HTMLButtonElement>("#api-custom-tab")
  const geminiTab = $<HTMLButtonElement>("#api-gemini-tab")
  const customPanel = $("#api-custom-panel")
  const geminiPanel = $("#api-gemini-panel")
  const badge = $("#api-connection-badge")

  const form = $<HTMLFormElement>("#api-inspector-form")
  const endpoint = $<HTMLInputElement>("#api-inspector-endpoint")
  const apiKey = $<HTMLInputElement>("#api-inspector-key")
  const protocol = $<HTMLSelectElement>("#api-inspector-protocol")
  const discoverBtn = $<HTMLButtonElement>("#api-discover-btn")
  const visibilityBtn = $<HTMLButtonElement>("#api-key-visibility")
  const count = $("#api-model-count")
  const search = $<HTMLInputElement>("#api-model-search")
  const list = $("#api-model-list")
  const findBtn = $<HTMLButtonElement>("#api-find-model-btn")
  const saveBtn = $<HTMLButtonElement>("#api-save-model-btn")
  const testBtn = $<HTMLButtonElement>("#api-test-model-btn")
  const output = $("#api-test-output")

  const geminiForm = $<HTMLFormElement>("#gemini-inspector-form")
  const geminiKey = $<HTMLInputElement>("#gemini-inspector-key")
  const geminiVisibilityBtn = $<HTMLButtonElement>("#gemini-key-visibility")
  const geminiDiscoverBtn = $<HTMLButtonElement>("#gemini-discover-btn")
  const geminiCount = $("#gemini-model-count")
  const geminiSearch = $<HTMLInputElement>("#gemini-model-search")
  const geminiList = $("#gemini-model-list")
  const geminiTestBtn = $<HTMLButtonElement>("#gemini-test-model-btn")
  const geminiSaveBtn = $<HTMLButtonElement>("#gemini-save-model-btn")
  const geminiOutput = $("#gemini-test-output")
  const adminGate = $("#api-admin-gate")
  const adminContent = $("#api-admin-content")
  const adminForm = $<HTMLFormElement>("#api-admin-form")
  const adminTitle = $("#api-admin-title")
  const adminDescription = $("#api-admin-description")
  const adminUsername = $<HTMLInputElement>("#api-admin-username")
  const adminPassword = $<HTMLInputElement>("#api-admin-password")
  const adminLoginBtn = $<HTMLButtonElement>("#api-admin-login-btn")
  const adminLogoutBtn = $<HTMLButtonElement>("#api-admin-logout-btn")
  const adminMessage = $("#api-admin-message")
  const adminIdentity = $("#api-admin-identity")

  let activeProvider: "custom" | "gemini" = "custom"
  let models: ApiModel[] = []
  let selectedModel = ""
  let geminiModels: ApiModel[] = []
  let selectedGeminiModel = ""
  let adminConfigured = false
  let adminAuthenticated = false
  let backendConfigLoaded = false
  let hasSavedCustomKey = false
  let hasSavedGeminiKey = false

  function setView(view: "subtitle" | "api") {
    if (!app || !inspector) return
    const showApi = view === "api"
    app.hidden = showApi
    inspector.hidden = !showApi
    subtitleTab?.classList.toggle("is-active", !showApi)
    apiTab?.classList.toggle("is-active", showApi)
    subtitleTab?.setAttribute("aria-pressed", String(!showApi))
    apiTab?.setAttribute("aria-pressed", String(showApi))
    if (showApi) {
      void openAdmin()
    }
  }

  async function adminJson(url: string, options: RequestInit = {}) {
    const response = await fetch(url, {
      ...options,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data.ok === false) {
      throw new Error(data.message || data.error || `HTTP ${response.status}`)
    }
    return data
  }

  function renderAdminAccess(data: {
    configured?: boolean
    authenticated?: boolean
    username?: string
  }) {
    adminConfigured = Boolean(data.configured)
    adminAuthenticated = Boolean(data.authenticated)
    if (adminGate) adminGate.hidden = adminAuthenticated
    if (adminContent) adminContent.hidden = !adminAuthenticated
    if (adminAuthenticated) {
      if (adminIdentity) {
        adminIdentity.textContent = data.username
          ? `Quản trị: ${data.username}`
          : "Quản trị đã xác thực"
      }
      if (adminMessage) adminMessage.textContent = ""
      return
    }
    if (adminTitle) {
      adminTitle.textContent = adminConfigured
        ? "Đăng nhập quản trị API"
        : "Quản trị API chưa được cấu hình"
    }
    if (adminDescription) {
      adminDescription.textContent = adminConfigured
        ? "Nhập tài khoản quản trị để mở endpoint, khóa API và model đã lưu."
        : "Tài khoản chỉ được tạo hoặc thay đổi trực tiếp trên backend."
    }
    if (adminLoginBtn) adminLoginBtn.disabled = !adminConfigured
    adminUsername?.focus()
  }

  function resetAdminWorkspace() {
    backendConfigLoaded = false
    hasSavedCustomKey = false
    hasSavedGeminiKey = false
    models = []
    geminiModels = []
    selectedModel = ""
    selectedGeminiModel = ""
    if (endpoint) endpoint.value = ""
    if (apiKey) apiKey.value = ""
    if (geminiKey) geminiKey.value = ""
    renderCustomModels()
    renderGeminiModels()
  }

  async function openAdmin() {
    if (adminMessage) adminMessage.textContent = ""
    try {
      const data = await adminJson("/api/api-admin/status")
      renderAdminAccess(data)
      if (data.authenticated && !backendConfigLoaded) {
        await restoreBackendConfiguration()
      }
    } catch (error) {
      renderAdminAccess({ configured: adminConfigured, authenticated: false })
      if (adminMessage) adminMessage.textContent = String((error as Error)?.message || error)
    }
  }

  function setProviderTab(provider: "custom" | "gemini") {
    activeProvider = provider
    const isCustom = provider === "custom"
    if (customPanel) customPanel.hidden = !isCustom
    if (geminiPanel) geminiPanel.hidden = isCustom
    customTab?.classList.toggle("is-active", isCustom)
    geminiTab?.classList.toggle("is-active", !isCustom)
    customTab?.setAttribute("aria-selected", String(isCustom))
    geminiTab?.setAttribute("aria-selected", String(!isCustom))
    setBadge(
      provider === "custom" ? "API tùy chỉnh" : "Gemini",
      "idle",
    )
  }

  function setBadge(message: string, state: "idle" | "busy" | "ok" | "error") {
    if (!badge) return
    badge.textContent = message
    badge.dataset.state = state
  }

  function setOutput(
    target: HTMLElement | undefined,
    title: string,
    detail: string,
    state: "idle" | "busy" | "ok" | "error" = "idle",
  ) {
    if (!target) return
    target.dataset.state = state
    target.replaceChildren()
    const strong = document.createElement("strong")
    strong.textContent = title
    const span = document.createElement("span")
    span.textContent = detail
    target.append(strong, span)
  }

  function persistCustomConnection() {
    saveTranslateSettings({
      baseUrl: endpoint?.value.trim() || "",
      apiKey: "",
      protocol: (protocol?.value || "auto") as Protocol,
    })
  }

  function persistCustomModel() {
    saveTranslateSettings({
      provider: "custom",
      baseUrl: endpoint?.value.trim() || "",
      apiKey: "",
      model: selectedModel,
      verifiedModel: selectedModel,
      models: selectedModel ? [selectedModel] : [],
      protocol: (protocol?.value || "auto") as Protocol,
    })
    window.dispatchEvent(new CustomEvent("subvid:translate-settings-changed"))
  }

  function persistGeminiModel() {
    saveGeminiSettings({
      apiKey: "",
      model: selectedGeminiModel,
    })
    saveTranslateSettings({ provider: "gemini" })
    window.dispatchEvent(new CustomEvent("subvid:translate-settings-changed"))
  }

  async function saveBackendCustom() {
    const data = await adminJson("/api/api-admin/config", {
      method: "POST",
      body: JSON.stringify({
        provider: "custom",
        custom: {
          baseUrl: endpoint?.value.trim() || "",
          apiKey: apiKey?.value.trim() || "",
          model: selectedModel,
          models: selectedModel ? [selectedModel] : [],
          protocol: (protocol?.value || "auto") as Protocol,
        },
      }),
    })
    hasSavedCustomKey = Boolean(data.custom?.hasApiKey)
    if (apiKey) {
      apiKey.value = ""
      apiKey.required = !hasSavedCustomKey
      apiKey.placeholder = hasSavedCustomKey
        ? "Đã có khóa ở backend · nhập để thay đổi"
        : "Nhập API key"
    }
    persistCustomModel()
    return data
  }

  async function saveBackendGemini() {
    const data = await adminJson("/api/api-admin/config", {
      method: "POST",
      body: JSON.stringify({
        provider: "gemini",
        gemini: {
          apiKey: geminiKey?.value.trim() || "",
          model: selectedGeminiModel,
        },
      }),
    })
    hasSavedGeminiKey = Boolean(data.gemini?.hasApiKey)
    if (geminiKey) {
      geminiKey.value = ""
      geminiKey.required = !hasSavedGeminiKey
      geminiKey.placeholder = hasSavedGeminiKey
        ? "Đã có khóa ở backend · nhập để thay đổi"
        : "Nhập Gemini API key"
    }
    persistGeminiModel()
    return data
  }

  async function restoreBackendConfiguration() {
    backendConfigLoaded = true
    try {
      const data = await adminJson("/api/api-admin/config")
      const custom = data.custom || {}
      const gemini = data.gemini || {}
      hasSavedCustomKey = Boolean(custom.hasApiKey)
      hasSavedGeminiKey = Boolean(gemini.hasApiKey)
      if (endpoint) endpoint.value = String(custom.baseUrl || "")
      if (protocol) protocol.value = String(custom.protocol || "auto")
      if (apiKey) {
        apiKey.value = ""
        apiKey.required = !hasSavedCustomKey
        apiKey.placeholder = hasSavedCustomKey
          ? "Đã có khóa ở backend · nhập để thay đổi"
          : "Nhập API key"
      }
      if (geminiKey) {
        geminiKey.value = ""
        geminiKey.required = !hasSavedGeminiKey
        geminiKey.placeholder = hasSavedGeminiKey
          ? "Đã có khóa ở backend · nhập để thay đổi"
          : "Nhập Gemini API key"
      }
      saveTranslateSettings({
        provider: data.provider === "gemini" ? "gemini" : "custom",
        baseUrl: String(custom.baseUrl || ""),
        apiKey: "",
        model: String(custom.model || ""),
        verifiedModel: String(custom.model || ""),
        models: Array.isArray(custom.models) ? custom.models.map(String) : [],
        protocol: (custom.protocol || "auto") as Protocol,
      })
      saveGeminiSettings({
        apiKey: "",
        model: String(gemini.model || ""),
      })
      setProviderTab(data.provider === "gemini" ? "gemini" : "custom")
      if (data.provider === "gemini" && hasSavedGeminiKey) {
        await discoverGemini()
      } else if (custom.baseUrl && hasSavedCustomKey) {
        await discoverCustom()
      }
    } catch (error) {
      backendConfigLoaded = false
      throw error
    }
  }

  function renderModelList(options: {
    target?: HTMLElement
    searchValue: string
    items: ApiModel[]
    selected: string
    radioName: string
    emptyLabel: string
    onSelect: (model: ApiModel) => void
  }) {
    const { target, searchValue, items, selected, radioName, emptyLabel, onSelect } = options
    if (!target) return
    const query = searchValue.trim().toLowerCase()
    const visible = items.filter((model) =>
      !query ||
      `${model.id} ${model.owned_by || ""} ${model.display_name || ""}`
        .toLowerCase()
        .includes(query),
    )
    target.replaceChildren()

    if (!visible.length) {
      const empty = document.createElement("div")
      empty.className = "api-model-empty"
      const marker = document.createElement("span")
      marker.textContent = items.length ? "00" : "01"
      const message = document.createElement("p")
      message.textContent = items.length ? "Không có model khớp bộ lọc." : emptyLabel
      empty.append(marker, message)
      target.appendChild(empty)
      return
    }

    for (const model of visible) {
      const label = document.createElement("label")
      label.className = "api-model-item"
      label.dataset.selected = String(model.id === selected)

      const radio = document.createElement("input")
      radio.type = "radio"
      radio.name = radioName
      radio.value = model.id
      radio.checked = model.id === selected

      const body = document.createElement("span")
      body.className = "api-model-copy"
      const name = document.createElement("strong")
      name.textContent = model.id
      const meta = document.createElement("small")
      meta.textContent = model.display_name || model.owned_by || "Nhà cung cấp API"
      body.append(name, meta)
      label.append(radio, body)

      const flag = document.createElement("em")
      if (model.testState === "ok") {
        flag.textContent = "Đã test · hoạt động"
        label.appendChild(flag)
      } else if (model.testState === "error") {
        flag.className = "is-error"
        flag.textContent = "Test thất bại"
        label.appendChild(flag)
      } else if (model.recommended) {
        flag.textContent = "Nên thử"
        label.appendChild(flag)
      }

      radio.addEventListener("change", () => onSelect(model))
      target.appendChild(label)
    }
  }

  function renderCustomModels() {
    renderModelList({
      target: list,
      searchValue: search?.value || "",
      items: models,
      selected: selectedModel,
      radioName: "api-inspector-model",
      emptyLabel: "Endpoint không trả về model văn bản phù hợp.",
      onSelect(model) {
        selectedModel = model.id
        if (saveBtn) saveBtn.disabled = model.testState !== "ok"
        if (testBtn) testBtn.disabled = false
        setOutput(
          output,
          `Đã chọn ${model.id}`,
          "Bấm “Test API model đã chọn”. Sau khi test thành công, nút xác nhận sẽ được mở.",
        )
        renderCustomModels()
      },
    })
  }

  function renderGeminiModels() {
    renderModelList({
      target: geminiList,
      searchValue: geminiSearch?.value || "",
      items: geminiModels,
      selected: selectedGeminiModel,
      radioName: "gemini-inspector-model",
      emptyLabel: "Gemini không trả về model tạo nội dung phù hợp.",
      onSelect(model) {
        selectedGeminiModel = model.id
        if (geminiSaveBtn) geminiSaveBtn.disabled = model.testState !== "ok"
        if (geminiTestBtn) geminiTestBtn.disabled = false
        setOutput(
          geminiOutput,
          `Đã chọn ${model.id}`,
          "Bấm “Test API model đã chọn”. Sau khi test thành công, nút xác nhận sẽ được mở.",
        )
        renderGeminiModels()
      },
    })
  }

  async function discoverCustom() {
    const baseUrl = endpoint?.value.trim() || ""
    const key = apiKey?.value.trim() || ""
    if (!baseUrl || (!key && !hasSavedCustomKey)) {
      setBadge("Thiếu thông tin", "error")
      setOutput(output, "Chưa thể kiểm tra", "Hãy nhập đầy đủ endpoint và API key.", "error")
      return
    }

    if (discoverBtn) discoverBtn.disabled = true
    setBadge("Đang kết nối…", "busy")
    setOutput(output, "Đang xác thực endpoint", "Subvid đang tải danh sách model.", "busy")
    try {
      const available = await listCustomTranslateModels({ baseUrl, apiKey: key })
      models = normalizeModels(available)
      const saved = loadSavedTranslateSettings()
      selectedModel = models.some((model) => model.id === saved.verifiedModel)
        ? saved.verifiedModel
        : models[0]?.id || ""
      if (search) {
        search.disabled = false
        search.value = ""
      }
      if (count) count.textContent = `${models.length} model văn bản · ${available.length} model tổng`
      if (saveBtn) saveBtn.disabled = true
      if (testBtn) testBtn.disabled = !selectedModel
      if (findBtn) findBtn.disabled = !selectedModel
      renderCustomModels()
      persistCustomConnection()
      setBadge("Endpoint hợp lệ", "ok")
      setOutput(
        output,
        "Đã tải model",
        selectedModel
          ? `Đang chọn ${selectedModel}. Route kiểm tra: ${protocolLabel(detectedProtocol(
              models.find((model) => model.id === selectedModel),
              baseUrl,
              (protocol?.value || "auto") as Protocol,
            ))}. Hãy test API trước khi xác nhận.`
          : "Không tìm thấy model văn bản phù hợp.",
        selectedModel ? "ok" : "error",
      )
    } catch (error) {
      models = []
      selectedModel = ""
      renderCustomModels()
      if (search) search.disabled = true
      if (count) count.textContent = "Không tải được model"
      if (saveBtn) saveBtn.disabled = true
      if (testBtn) testBtn.disabled = true
      if (findBtn) findBtn.disabled = true
      setBadge("Kết nối lỗi", "error")
      setOutput(output, "Không thể xác thực API", friendlyError(error, "", baseUrl), "error")
    } finally {
      if (discoverBtn) discoverBtn.disabled = false
    }
  }

  async function probeCustom(model: ApiModel) {
    const selectedProtocol = (protocol?.value || "auto") as Protocol
    return testTranslateApi({
      provider: "custom",
      baseUrl: endpoint?.value.trim(),
      apiKey: apiKey?.value.trim(),
      model: model.id,
      models: [model.id],
      protocol: detectedProtocol(
        model,
        endpoint?.value.trim() || "",
        selectedProtocol,
      ),
    })
  }

  async function testCustomModel() {
    const model = models.find((item) => item.id === selectedModel)
    if (!model) return
    if (testBtn) testBtn.disabled = true
    if (findBtn) findBtn.disabled = true
    if (saveBtn) saveBtn.disabled = true
    setOutput(output, `Đang test ${selectedModel}`, "Gửi một câu dịch ngắn qua đúng endpoint và model…", "busy")
    try {
      const result = await probeCustom(model)
      model.testState = "ok"
      await saveBackendCustom()
      if (saveBtn) saveBtn.disabled = false
      setBadge("API hoạt động · đã lưu", "ok")
      setOutput(
        output,
        `${selectedModel} hoạt động và đã tự lưu`,
        (result.diagnostic ||
          `Phản hồi ${result.elapsedMs} ms · ${protocolLabel(result.engine?.split(":")[1])} · HTTP ${result.httpStatus} · ${result.translation}`) +
          " · Lần sau Subvid sẽ tự nạp endpoint, khóa và model này.",
        "ok",
      )
    } catch (error) {
      model.testState = "error"
      const saved = loadSavedTranslateSettings()
      if (saved.verifiedModel === model.id) {
        saveTranslateSettings({ verifiedModel: "" })
      }
      setBadge("Model lỗi", "error")
      setOutput(
        output,
        `${selectedModel} chưa dùng được`,
        friendlyError(error, selectedModel, endpoint?.value.trim() || ""),
        "error",
      )
    } finally {
      renderCustomModels()
      if (testBtn) testBtn.disabled = false
      if (findBtn) findBtn.disabled = false
    }
  }

  async function findWorkingModel() {
    if (!models.length) return
    const candidates = models.filter((model) => model.testState !== "error")
    if (!candidates.length) {
      setBadge("Không còn model để thử", "error")
      setOutput(
        output,
        "API key không dùng được model nào",
        "Tất cả model đã kiểm tra đều thất bại. Hãy đổi API key, nâng quyền tài khoản hoặc chuyển sang Gemini.",
        "error",
      )
      return
    }
    if (findBtn) findBtn.disabled = true
    if (testBtn) testBtn.disabled = true
    if (saveBtn) saveBtn.disabled = true
    let lastError = ""
    try {
      for (let index = 0; index < candidates.length; index += 1) {
        const model = candidates[index]
        selectedModel = model.id
        renderCustomModels()
        setBadge(`Đang thử ${index + 1}/${candidates.length}`, "busy")
        setOutput(
          output,
          `Đang test ${model.id}`,
          `Test model ${index + 1}/${candidates.length}; model lỗi hoặc 403 sẽ được bỏ qua.`,
          "busy",
        )
        try {
          const result = await probeCustom(model)
          model.testState = "ok"
          await saveBackendCustom()
          if (saveBtn) saveBtn.disabled = false
          setBadge("Đã tìm thấy model · đã lưu", "ok")
          setOutput(
            output,
            `${model.id} hoạt động`,
            (result.diagnostic ||
              `Phản hồi ${result.elapsedMs} ms · ${protocolLabel(result.engine?.split(":")[1])} · HTTP ${result.httpStatus} · ${result.translation}`) +
              " · Đã lưu ở backend cho lần sau.",
            "ok",
          )
          renderCustomModels()
          return
        } catch (error) {
          model.testState = "error"
          lastError = friendlyError(error, model.id, endpoint?.value.trim() || "")
          renderCustomModels()
        }
      }
      setBadge("Không có model dùng được", "error")
      setOutput(
        output,
        "Không tìm thấy model hoạt động",
        lastError || "Tất cả model đều thất bại khi gọi thử.",
        "error",
      )
    } finally {
      if (findBtn) findBtn.disabled = false
      if (testBtn) testBtn.disabled = false
    }
  }

  async function discoverGemini() {
    const key = geminiKey?.value.trim() || ""
    if (!key && !hasSavedGeminiKey) {
      setBadge("Thiếu Gemini key", "error")
      setOutput(geminiOutput, "Chưa thể kiểm tra Gemini", "Hãy nhập Gemini API key.", "error")
      return
    }
    if (geminiDiscoverBtn) geminiDiscoverBtn.disabled = true
    setBadge("Đang kiểm tra Gemini…", "busy")
    setOutput(geminiOutput, "Đang xác thực Gemini API", "Subvid đang tải model hỗ trợ generateContent.", "busy")
    try {
      const available = await listGeminiModels({ apiKey: key })
      geminiModels = normalizeModels(available)
      const saved = loadSavedGeminiSettings()
      selectedGeminiModel = geminiModels.some((model) => model.id === saved.model)
        ? saved.model
        : geminiModels[0]?.id || ""
      if (geminiSearch) {
        geminiSearch.disabled = false
        geminiSearch.value = ""
      }
      if (geminiCount) geminiCount.textContent = `${geminiModels.length} model tạo nội dung`
      if (geminiTestBtn) geminiTestBtn.disabled = !selectedGeminiModel
      if (geminiSaveBtn) geminiSaveBtn.disabled = true
      saveGeminiSettings({ apiKey: "" })
      renderGeminiModels()
      setBadge("Gemini key hợp lệ", "ok")
      setOutput(
        geminiOutput,
        "Đã tải model Gemini",
        selectedGeminiModel
          ? `Đang chọn ${selectedGeminiModel}. Hãy test API trước khi xác nhận.`
          : "Không tìm thấy model Gemini tạo nội dung phù hợp.",
        selectedGeminiModel ? "ok" : "error",
      )
    } catch (error) {
      geminiModels = []
      selectedGeminiModel = ""
      renderGeminiModels()
      if (geminiSearch) geminiSearch.disabled = true
      if (geminiCount) geminiCount.textContent = "Không tải được model"
      if (geminiTestBtn) geminiTestBtn.disabled = true
      if (geminiSaveBtn) geminiSaveBtn.disabled = true
      setBadge("Gemini lỗi", "error")
      setOutput(geminiOutput, "Không thể xác thực Gemini API", friendlyError(error), "error")
    } finally {
      if (geminiDiscoverBtn) geminiDiscoverBtn.disabled = false
    }
  }

  async function testGeminiModel() {
    const model = geminiModels.find((item) => item.id === selectedGeminiModel)
    const key = geminiKey?.value.trim() || ""
    if (!model || !key) return
    if (geminiTestBtn) geminiTestBtn.disabled = true
    if (geminiSaveBtn) geminiSaveBtn.disabled = true
    setOutput(
      geminiOutput,
      `Đang test ${selectedGeminiModel}`,
      "Gửi một câu dịch ngắn qua Gemini API…",
      "busy",
    )
    try {
      const result = await testTranslateApi({
        provider: "gemini",
        model: selectedGeminiModel,
        geminiApiKey: key,
      })
      model.testState = "ok"
      await saveBackendGemini()
      if (geminiSaveBtn) geminiSaveBtn.disabled = false
      setBadge("Gemini hoạt động · đã lưu", "ok")
      setOutput(
        geminiOutput,
        `${selectedGeminiModel} hoạt động và đã tự lưu`,
        `Phản hồi ${result.elapsedMs} ms · HTTP ${result.httpStatus} · ${result.translation} · Lần sau Subvid sẽ tự nạp khóa và model này.`,
        "ok",
      )
    } catch (error) {
      model.testState = "error"
      setBadge("Gemini model lỗi", "error")
      setOutput(
        geminiOutput,
        `${selectedGeminiModel} chưa dùng được`,
        friendlyError(error, selectedGeminiModel),
        "error",
      )
    } finally {
      renderGeminiModels()
      if (geminiTestBtn) geminiTestBtn.disabled = false
    }
  }

  function toggleKeyVisibility(input?: HTMLInputElement, button?: HTMLButtonElement) {
    if (!input || !button) return
    const showing = input.type === "text"
    input.type = showing ? "password" : "text"
    button.textContent = showing ? "Hiện" : "Ẩn"
    button.setAttribute("aria-pressed", String(!showing))
  }

  function wire() {
    setProviderTab("custom")

    subtitleTab?.addEventListener("click", () => setView("subtitle"))
    apiTab?.addEventListener("click", () => setView("api"))
    adminForm?.addEventListener("submit", (event) => {
      event.preventDefault()
      if (!adminConfigured) {
        if (adminMessage) {
          adminMessage.textContent = "Tài khoản quản trị chưa được cấu hình ở backend."
        }
        return
      }
      if (adminLoginBtn) adminLoginBtn.disabled = true
      if (adminMessage) adminMessage.textContent = "Đang xác thực…"
      void adminJson("/api/api-admin/login", {
        method: "POST",
        body: JSON.stringify({
          username: adminUsername?.value.trim() || "",
          password: adminPassword?.value || "",
        }),
      })
        .then(async (data) => {
          if (adminPassword) adminPassword.value = ""
          backendConfigLoaded = false
          renderAdminAccess({
            configured: true,
            authenticated: true,
            username: data.username,
          })
          await openAdmin()
        })
        .catch((error) => {
          if (adminMessage) {
            adminMessage.textContent = String((error as Error)?.message || error)
          }
        })
        .finally(() => {
          if (adminLoginBtn) adminLoginBtn.disabled = !adminConfigured
        })
    })
    adminLogoutBtn?.addEventListener("click", () => {
      void adminJson("/api/api-admin/logout", {
        method: "POST",
        body: "{}",
      }).finally(() => {
        resetAdminWorkspace()
        renderAdminAccess({ configured: true, authenticated: false })
      })
    })
    customTab?.addEventListener("click", () => setProviderTab("custom"))
    geminiTab?.addEventListener("click", () => setProviderTab("gemini"))
    form?.addEventListener("submit", (event) => {
      event.preventDefault()
      void discoverCustom()
    })
    geminiForm?.addEventListener("submit", (event) => {
      event.preventDefault()
      void discoverGemini()
    })
    visibilityBtn?.addEventListener("click", () => toggleKeyVisibility(apiKey, visibilityBtn))
    geminiVisibilityBtn?.addEventListener("click", () =>
      toggleKeyVisibility(geminiKey, geminiVisibilityBtn),
    )
    search?.addEventListener("input", renderCustomModels)
    geminiSearch?.addEventListener("input", renderGeminiModels)
    testBtn?.addEventListener("click", () => void testCustomModel())
    findBtn?.addEventListener("click", () => void findWorkingModel())
    geminiTestBtn?.addEventListener("click", () => void testGeminiModel())
    saveBtn?.addEventListener("click", () => {
      const model = models.find((item) => item.id === selectedModel)
      if (model?.testState !== "ok") return
      void saveBackendCustom()
        .then(() => {
          setBadge("Đã xác nhận API tùy chỉnh", "ok")
          setOutput(
            output,
            "Đã xác nhận và lưu model ở backend",
            `${selectedModel} sẽ được dùng mặc định cho dịch phụ đề.`,
            "ok",
          )
        })
        .catch((error) => {
          setBadge("Lưu cấu hình lỗi", "error")
          setOutput(
            output,
            "Không thể lưu cấu hình",
            String((error as Error)?.message || error),
            "error",
          )
        })
    })
    geminiSaveBtn?.addEventListener("click", () => {
      const model = geminiModels.find((item) => item.id === selectedGeminiModel)
      if (model?.testState !== "ok") return
      void saveBackendGemini()
        .then(() => {
          setBadge("Đã xác nhận Gemini", "ok")
          setOutput(
            geminiOutput,
            "Đã xác nhận và lưu Gemini ở backend",
            `${selectedGeminiModel} sẽ được dùng cho dịch phụ đề khi chọn Gemini.`,
            "ok",
          )
        })
        .catch((error) => {
          setBadge("Lưu Gemini lỗi", "error")
          setOutput(
            geminiOutput,
            "Không thể lưu cấu hình Gemini",
            String((error as Error)?.message || error),
            "error",
          )
        })
    })
  }

  return { wire, setView }
}

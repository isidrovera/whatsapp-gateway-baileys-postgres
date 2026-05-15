import type { FastifyInstance } from 'fastify';

export async function registerUiRoutes(app: FastifyInstance) {
  app.get('/', async (_request, reply) => {
    reply.type('text/html');

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <title>WhatsApp Gateway Baileys</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />

  <style>
    :root {
      --bg: #f4f6fb;
      --card: #ffffff;
      --primary: #2563eb;
      --primary-dark: #1d4ed8;
      --success: #059669;
      --danger: #dc2626;
      --warning: #d97706;
      --dark: #111827;
      --muted: #6b7280;
      --border: #d1d5db;
      --soft: #eef2ff;
    }

    * {
      box-sizing: border-box;
    }

    body {
      font-family: Arial, sans-serif;
      background: var(--bg);
      margin: 0;
      color: #1f2937;
    }

    header {
      background: var(--dark);
      color: white;
      padding: 18px 24px;
    }

    header h1 {
      margin: 0;
      font-size: 22px;
    }

    header div {
      margin-top: 4px;
      color: #d1d5db;
      font-size: 14px;
    }

    main {
      max-width: 1180px;
      margin: 24px auto;
      padding: 0 16px 40px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      gap: 16px;
    }

    .card {
      background: var(--card);
      border-radius: 14px;
      padding: 18px;
      box-shadow: 0 2px 10px rgba(0,0,0,.08);
      border: 1px solid #e5e7eb;
    }

    h2 {
      margin: 0 0 12px;
      font-size: 18px;
    }

    label {
      display: block;
      margin-top: 10px;
      font-size: 13px;
      font-weight: bold;
    }

    input, select, textarea {
      width: 100%;
      padding: 10px;
      margin-top: 5px;
      border: 1px solid var(--border);
      border-radius: 9px;
      outline: none;
      font-size: 14px;
    }

    input:focus, textarea:focus, select:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(37,99,235,.15);
    }

    textarea {
      min-height: 90px;
      resize: vertical;
    }

    button {
      border: none;
      border-radius: 9px;
      padding: 10px 14px;
      margin-top: 12px;
      cursor: pointer;
      background: var(--primary);
      color: white;
      font-weight: bold;
      font-size: 14px;
    }

    button:hover {
      background: var(--primary-dark);
    }

    button.secondary {
      background: #4b5563;
    }

    button.secondary:hover {
      background: #374151;
    }

    button.danger {
      background: var(--danger);
    }

    button.success {
      background: var(--success);
    }

    button.warning {
      background: var(--warning);
    }

    .row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }

    .status {
      padding: 8px 10px;
      border-radius: 8px;
      display: inline-block;
      font-weight: bold;
      margin-bottom: 8px;
    }

    .ok {
      background: #dcfce7;
      color: #166534;
    }

    .bad {
      background: #fee2e2;
      color: #991b1b;
    }

    .pending {
      background: #fef3c7;
      color: #92400e;
    }

    .muted {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.4;
    }

    .key-box {
      background: #f8fafc;
      border: 1px dashed #94a3b8;
      border-radius: 10px;
      padding: 10px;
      font-family: monospace;
      word-break: break-all;
      margin-top: 10px;
      display: none;
    }

    #qrImg {
      max-width: 300px;
      width: 100%;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      display: none;
      margin-top: 12px;
      padding: 8px;
      background: white;
    }

    pre {
      background: #0f172a;
      color: #e5e7eb;
      padding: 12px;
      border-radius: 8px;
      overflow: auto;
      max-height: 250px;
      font-size: 12px;
    }

    .top-actions {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }

    .pill {
      display: inline-block;
      padding: 6px 10px;
      border-radius: 999px;
      background: var(--soft);
      color: #3730a3;
      font-weight: bold;
      font-size: 13px;
    }

    /* MODAL */
    .modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, .65);
      z-index: 9999;
      align-items: center;
      justify-content: center;
      padding: 18px;
    }

    .modal {
      width: 100%;
      max-width: 620px;
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 50px rgba(0,0,0,.35);
      overflow: hidden;
      animation: pop .15s ease-out;
    }

    @keyframes pop {
      from { transform: scale(.96); opacity: .6; }
      to { transform: scale(1); opacity: 1; }
    }

    .modal-header {
      padding: 16px 18px;
      color: white;
      font-weight: bold;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .modal-header.success {
      background: var(--success);
    }

    .modal-header.error {
      background: var(--danger);
    }

    .modal-header.info {
      background: var(--primary);
    }

    .modal-header.warning {
      background: var(--warning);
    }

    .modal-body {
      padding: 18px;
    }

    .modal-body p {
      margin-top: 0;
      line-height: 1.5;
    }

    .modal-actions {
      padding: 12px 18px 18px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .close-x {
      background: rgba(255,255,255,.2);
      border: none;
      color: white;
      font-size: 18px;
      margin: 0;
      padding: 4px 10px;
    }

    .copy-input {
      font-family: monospace;
      background: #f8fafc;
    }
  </style>
</head>

<body>
  <header>
    <h1>WhatsApp Gateway Baileys</h1>
    <div>Panel de administración con PostgreSQL</div>
  </header>

  <main>
    <div class="top-actions">
      <span class="pill">Gateway API + Baileys + n8n/Odoo</span>
      <div class="row">
        <button onclick="loadStatus()">Actualizar estado</button>
        <button class="secondary" onclick="loadConfig()">Cargar configuración</button>
      </div>
    </div>

    <div class="grid">

      <section class="card">
        <h2>Acceso administrador</h2>
        <p class="muted">
          Usa la clave actual para administrar el gateway. La clave inicial es
          <b>change-me-gateway-api-key</b>. Luego genera una nueva.
        </p>

        <label>API Key actual</label>
        <input id="apiKey" type="password" placeholder="API key del gateway" />

        <div class="row">
          <button onclick="saveApiKeyLocal()">Guardar local</button>
          <button class="secondary" onclick="toggleApiKey()">Ver / ocultar</button>
          <button class="warning" onclick="generateApiKey()">Generar nueva API key</button>
        </div>

        <div id="generatedKeyBox" class="key-box"></div>
      </section>

      <section class="card">
        <h2>Estado WhatsApp</h2>

        <div id="waStatus" class="status bad">Sin consultar</div>

        <div class="row">
          <button onclick="loadStatus()">Actualizar</button>
          <button class="secondary" onclick="loadQR()">Ver QR</button>
        </div>

        <img id="qrImg" />

        <pre id="statusRaw">{}</pre>
      </section>

      <section class="card">
        <h2>Sesión WhatsApp</h2>

        <label>Teléfono para pairing code</label>
        <input id="pairingPhone" placeholder="51999999999" />

        <div class="row">
          <button onclick="requestPairingCode()">Generar pairing code</button>
          <button class="secondary" onclick="reconnect()">Reconectar</button>
          <button class="danger" onclick="logout()">Cerrar sesión y limpiar</button>
        </div>

        <pre id="authRaw">{}</pre>
      </section>

      <section class="card">
        <h2>Configuración dinámica</h2>

        <label>Webhook n8n / servicio externo</label>
        <input id="INBOUND_WEBHOOK_URL" placeholder="https://n8n.../webhook/whatsapp-odoo-in" />

        <label>URL pública del gateway</label>
        <input id="PUBLIC_BASE_URL" placeholder="https://whatsapp-gateway.copiercompanysac.com" />

        <label>Odoo URL</label>
        <input id="ODOO_BASE_URL" placeholder="https://andessolutioncopiers.com" />

        <label>Odoo token WhatsApp</label>
        <input id="ODOO_WHATSAPP_TOKEN" placeholder="sat_xxx" />

        <label>Marcar outbox enviado en Odoo</label>
        <select id="ODOO_MARK_SENT_ENABLED">
          <option value="true">Sí</option>
          <option value="false">No</option>
        </select>

        <label>Ignorar grupos</label>
        <select id="IGNORE_GROUPS">
          <option value="true">Sí</option>
          <option value="false">No</option>
        </select>

        <label>Reportar grupos al webhook</label>
        <select id="REPORT_GROUPS_TO_WEBHOOK">
          <option value="true">Sí</option>
          <option value="false">No</option>
        </select>

        <div class="row">
          <button class="success" onclick="saveConfig()">Guardar configuración</button>
        </div>
      </section>

      <section class="card">
        <h2>Prueba de envío</h2>

        <label>Destino</label>
        <input id="sendTo" placeholder="51924894792" />

        <label>Mensaje</label>
        <textarea id="sendMessage">Prueba desde gateway Baileys</textarea>

        <button onclick="sendTestMessage()">Enviar prueba</button>

        <pre id="sendRaw">{}</pre>
      </section>

      <section class="card">
        <h2>Resultado</h2>
        <pre id="resultRaw">{}</pre>
      </section>

    </div>
  </main>

  <div id="modalBackdrop" class="modal-backdrop">
    <div class="modal">
      <div id="modalHeader" class="modal-header info">
        <span id="modalTitle">Mensaje</span>
        <button class="close-x" onclick="closeModal()">×</button>
      </div>

      <div class="modal-body">
        <p id="modalMessage"></p>

        <div id="modalCopyArea" style="display:none;">
          <label id="modalCopyLabel">Valor</label>
          <input id="modalCopyInput" class="copy-input" readonly />
        </div>

        <pre id="modalRaw" style="display:none;"></pre>
      </div>

      <div class="modal-actions">
        <button id="copyModalButton" class="secondary" style="display:none;" onclick="copyModalValue()">Copiar</button>
        <button onclick="closeModal()">Cerrar</button>
      </div>
    </div>
  </div>

<script>
  const apiKeyInput = document.getElementById('apiKey');
  apiKeyInput.value = localStorage.getItem('gateway_api_key') || 'change-me-gateway-api-key';

  function apiKey() {
    return apiKeyInput.value.trim();
  }

  function headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey()
    };
  }

  function showResult(data) {
    document.getElementById('resultRaw').textContent = JSON.stringify(data, null, 2);
  }

  function openModal(type, title, message, options = {}) {
    const backdrop = document.getElementById('modalBackdrop');
    const header = document.getElementById('modalHeader');
    const titleEl = document.getElementById('modalTitle');
    const msgEl = document.getElementById('modalMessage');
    const copyArea = document.getElementById('modalCopyArea');
    const copyInput = document.getElementById('modalCopyInput');
    const copyLabel = document.getElementById('modalCopyLabel');
    const copyButton = document.getElementById('copyModalButton');
    const raw = document.getElementById('modalRaw');

    header.className = 'modal-header ' + (type || 'info');
    titleEl.textContent = title || 'Mensaje';
    msgEl.textContent = message || '';

    if (options.copyValue) {
      copyArea.style.display = 'block';
      copyInput.value = options.copyValue;
      copyLabel.textContent = options.copyLabel || 'Valor';
      copyButton.style.display = 'inline-block';
    } else {
      copyArea.style.display = 'none';
      copyInput.value = '';
      copyButton.style.display = 'none';
    }

    if (options.raw) {
      raw.style.display = 'block';
      raw.textContent = JSON.stringify(options.raw, null, 2);
    } else {
      raw.style.display = 'none';
      raw.textContent = '';
    }

    backdrop.style.display = 'flex';
  }

  function closeModal() {
    document.getElementById('modalBackdrop').style.display = 'none';
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      openModal('success', 'Copiado', 'El valor fue copiado al portapapeles.');
    } catch (e) {
      openModal('warning', 'No se pudo copiar automáticamente', 'Copia el valor manualmente.', {
        copyValue: value,
        copyLabel: 'Valor'
      });
    }
  }

  function copyModalValue() {
    const value = document.getElementById('modalCopyInput').value;
    copyText(value);
  }

  function saveApiKeyLocal() {
    localStorage.setItem('gateway_api_key', apiKey());
    openModal('success', 'API key guardada', 'La API key fue guardada localmente en este navegador.');
  }

  function toggleApiKey() {
    apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
  }

  async function request(path, options = {}) {
    const res = await fetch(path, options);
    const text = await res.text();

    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      throw data;
    }

    return data;
  }

  async function loadStatus() {
    try {
      const data = await request('/api/status');
      document.getElementById('statusRaw').textContent = JSON.stringify(data, null, 2);

      const connected = data?.whatsapp?.connected;
      const hasQR = data?.whatsapp?.hasQR;
      const el = document.getElementById('waStatus');

      if (connected) {
        el.textContent = 'Conectado';
        el.className = 'status ok';
      } else if (hasQR) {
        el.textContent = 'Esperando escaneo QR';
        el.className = 'status pending';
      } else {
        el.textContent = 'Desconectado';
        el.className = 'status bad';
      }

      showResult(data);
    } catch (e) {
      showResult(e);
      openModal('error', 'Error consultando estado', 'No se pudo consultar el estado del gateway.', { raw: e });
    }
  }

  async function loadQR() {
    try {
      const data = await request('/api/qr');
      const img = document.getElementById('qrImg');

      if (data.qrDataURL) {
        img.src = data.qrDataURL;
        img.style.display = 'block';
        openModal('success', 'QR disponible', 'El QR fue cargado correctamente. Escanéalo desde WhatsApp.');
      } else {
        img.style.display = 'none';
        openModal('warning', 'QR no disponible', 'No hay QR disponible. Puede que WhatsApp ya esté conectado o aún esté iniciando.', { raw: data });
      }

      showResult(data);
    } catch (e) {
      showResult(e);
      openModal('error', 'Error cargando QR', 'No se pudo cargar el QR.', { raw: e });
    }
  }

  async function loadConfig() {
    try {
      const data = await request('/api/config', {
        headers: headers()
      });

      const cfg = data.config || {};

      for (const key of [
        'INBOUND_WEBHOOK_URL',
        'PUBLIC_BASE_URL',
        'ODOO_BASE_URL',
        'ODOO_WHATSAPP_TOKEN',
        'ODOO_MARK_SENT_ENABLED',
        'IGNORE_GROUPS',
        'REPORT_GROUPS_TO_WEBHOOK'
      ]) {
        const el = document.getElementById(key);
        if (el && cfg[key] !== undefined) {
          el.value = cfg[key];
        }
      }

      showResult(data);
      openModal('success', 'Configuración cargada', 'La configuración fue cargada desde PostgreSQL.');
    } catch (e) {
      showResult(e);
      openModal('error', 'Error cargando configuración', 'Verifica que la API key actual sea correcta.', { raw: e });
    }
  }

  async function saveConfig() {
    try {
      const body = {
        INBOUND_WEBHOOK_URL: document.getElementById('INBOUND_WEBHOOK_URL').value,
        PUBLIC_BASE_URL: document.getElementById('PUBLIC_BASE_URL').value,
        ODOO_BASE_URL: document.getElementById('ODOO_BASE_URL').value,
        ODOO_WHATSAPP_TOKEN: document.getElementById('ODOO_WHATSAPP_TOKEN').value,
        ODOO_MARK_SENT_ENABLED: document.getElementById('ODOO_MARK_SENT_ENABLED').value,
        IGNORE_GROUPS: document.getElementById('IGNORE_GROUPS').value,
        REPORT_GROUPS_TO_WEBHOOK: document.getElementById('REPORT_GROUPS_TO_WEBHOOK').value
      };

      const data = await request('/api/config', {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(body)
      });

      showResult(data);
      openModal('success', 'Configuración guardada', 'Los valores fueron guardados correctamente en PostgreSQL.');
    } catch (e) {
      showResult(e);
      openModal('error', 'Error guardando configuración', 'No se pudo guardar la configuración. Revisa la API key actual.', { raw: e });
    }
  }

  async function generateApiKey() {
    if (!confirm('Se generará una nueva API key. La clave anterior dejará de funcionar. ¿Continuar?')) {
      return;
    }

    try {
      const data = await request('/api/config/generate-api-key', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({})
        });

      if (!data.apiKey) {
        throw {
          ok: false,
          message: 'El endpoint no devolvió apiKey.',
          response: data
        };
      }

      apiKeyInput.value = data.apiKey;
      localStorage.setItem('gateway_api_key', data.apiKey);

      const box = document.getElementById('generatedKeyBox');
      box.style.display = 'block';
      box.textContent = data.apiKey;

      showResult(data);

      openModal(
        'success',
        'Nueva API key generada',
        'La nueva API key fue generada y guardada en PostgreSQL. También fue guardada localmente en este navegador.',
        {
          copyValue: data.apiKey,
          copyLabel: 'Nueva API key',
          raw: data
        }
      );
    } catch (e) {
      showResult(e);
      openModal('error', 'Error generando API key', 'No se pudo generar la API key. Verifica que estés usando la clave actual válida.', { raw: e });
    }
  }

  async function requestPairingCode() {
    try {
      const phone = document.getElementById('pairingPhone').value.trim();

      if (!phone) {
        openModal('warning', 'Teléfono requerido', 'Ingresa un número en formato internacional, por ejemplo 51999999999.');
        return;
      }

      const data = await request('/api/auth/pairing-code', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ phone })
      });

      document.getElementById('authRaw').textContent = JSON.stringify(data, null, 2);
      showResult(data);

      openModal('success', 'Pairing code generado', 'Usa este código para vincular WhatsApp.', {
        copyValue: data.code || '',
        copyLabel: 'Pairing code',
        raw: data
      });
    } catch (e) {
      document.getElementById('authRaw').textContent = JSON.stringify(e, null, 2);
      showResult(e);
      openModal('error', 'Error generando pairing code', 'No se pudo generar el pairing code.', { raw: e });
    }
  }

  async function reconnect() {
  try {
    const data = await request('/api/auth/reconnect', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({})
    });

    document.getElementById('authRaw').textContent = JSON.stringify(data, null, 2);
    showResult(data);

    openModal(
      'success',
      'Reconexión solicitada',
      'El gateway intentará reconectar WhatsApp.',
      { raw: data }
    );

    setTimeout(loadStatus, 1000);
    setTimeout(loadQR, 2000);
  } catch (e) {
    document.getElementById('authRaw').textContent = JSON.stringify(e, null, 2);
    showResult(e);

    openModal(
      'error',
      'Error reconectando',
      'No se pudo solicitar la reconexión.',
      { raw: e }
    );
  }
}

  async function logout() {
  if (!confirm('Esto cerrará sesión de WhatsApp, eliminará la carpeta auth y generará un nuevo inicio. ¿Continuar?')) {
    return;
  }

  try {
    const data = await request('/api/auth/logout', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({})
    });

    document.getElementById('authRaw').textContent = JSON.stringify(data, null, 2);
    showResult(data);

    openModal(
      'success',
      'Sesión cerrada y limpiada',
      'La sesión fue cerrada correctamente y la carpeta auth fue eliminada. Ahora puedes escanear un nuevo QR.',
      { raw: data }
    );

    setTimeout(loadStatus, 1000);
    setTimeout(loadQR, 2500);
  } catch (e) {
    document.getElementById('authRaw').textContent = JSON.stringify(e, null, 2);
    showResult(e);

    openModal(
      'error',
      'Error cerrando sesión',
      'No se pudo cerrar o limpiar la sesión.',
      { raw: e }
    );
  }
}

  async function sendTestMessage() {
    try {
      const to = document.getElementById('sendTo').value.trim();
      const message = document.getElementById('sendMessage').value.trim();

      if (!to || !message) {
        openModal('warning', 'Datos incompletos', 'Ingresa destino y mensaje para probar el envío.');
        return;
      }

      const data = await request('/api/messages/send', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ to, message })
      });

      document.getElementById('sendRaw').textContent = JSON.stringify(data, null, 2);
      showResult(data);

      openModal('success', 'Mensaje enviado', 'El mensaje de prueba fue enviado correctamente.', { raw: data });
    } catch (e) {
      document.getElementById('sendRaw').textContent = JSON.stringify(e, null, 2);
      showResult(e);
      openModal('error', 'Error enviando mensaje', 'No se pudo enviar el mensaje de prueba.', { raw: e });
    }
  }

  document.addEventListener('keydown', function(ev) {
    if (ev.key === 'Escape') closeModal();
  });

  loadStatus();
</script>
</body>
</html>`;
  });
}
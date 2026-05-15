# WhatsApp Gateway Baileys PostgreSQL

Este proyecto **no usa `.env` para la configuración funcional**.  
Trabaja con **PostgreSQL** y guarda la configuración en la tabla `Config`.

La única variable técnica es `DATABASE_URL`, definida en `docker-compose.yml`, para que la app se conecte a PostgreSQL.

## Arquitectura

```text
Baileys Gateway
- Conecta WhatsApp
- Recibe mensajes privados
- Ignora grupos y puede reportarlos
- Descarga multimedia
- Envía evento a n8n/Odoo/cualquier webhook
- Envía respuesta por WhatsApp
- Marca outbox enviado en Odoo si recibe outbox_id

PostgreSQL
- Config dinámica
- Logs de eventos
- Logs de mensajes
```

## Correr en Docker

```bash
unzip whatsapp-gateway-baileys-postgres.zip
cd whatsapp-gateway-baileys-postgres
docker compose up -d --build
docker logs -f whatsapp-gateway-baileys
```

## Estado

```bash
curl http://localhost:3105/health
curl http://localhost:3105/api/status
curl http://localhost:3105/api/qr
```

## API key inicial

La API key inicial se guarda automáticamente en PostgreSQL:

```text
change-me-gateway-api-key
```

Debes cambiarla con:

```bash
curl -X PUT "http://localhost:3105/api/config" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer change-me-gateway-api-key" \
  -d '{
    "GATEWAY_API_KEY": "MI_CLAVE_SEGURA",
    "INBOUND_WEBHOOK_URL": "https://n8n.copiercompanysac.com/webhook/whatsapp-odoo-in",
    "PUBLIC_BASE_URL": "https://whatsapp-gateway.copiercompanysac.com",
    "ODOO_BASE_URL": "https://andessolutioncopiers.com",
    "ODOO_WHATSAPP_TOKEN": "sat_xxx",
    "ODOO_MARK_SENT_ENABLED": "true"
  }'
```

Luego usa la nueva clave en los siguientes requests.

## Ver configuración

```bash
curl "http://localhost:3105/api/config" \
  -H "Authorization: Bearer MI_CLAVE_SEGURA"
```

## Pairing code manual

```bash
curl -X POST "http://localhost:3105/api/auth/pairing-code" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer MI_CLAVE_SEGURA" \
  -d '{"phone":"51999999999"}'
```

## Enviar texto

```bash
curl -X POST "http://localhost:3105/api/messages/send" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer MI_CLAVE_SEGURA" \
  -d '{"to":"51924894792","message":"Prueba desde gateway"}'
```

## Enviar multimedia

Por URL:

```bash
curl -X POST "http://localhost:3105/api/messages/send-media" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer MI_CLAVE_SEGURA" \
  -d '{
    "to":"51924894792",
    "media_type":"image",
    "url":"https://example.com/foto.jpg",
    "caption":"Foto prueba"
  }'
```

Por base64:

```bash
curl -X POST "http://localhost:3105/api/messages/send-media" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer MI_CLAVE_SEGURA" \
  -d '{
    "to":"51924894792",
    "media_type":"document",
    "base64":"BASE64_AQUI",
    "mimetype":"application/pdf",
    "filename":"archivo.pdf",
    "caption":"Documento"
  }'
```

## Grupos

Por defecto:

```text
IGNORE_GROUPS=true
REPORT_GROUPS_TO_WEBHOOK=true
```

Si llega un mensaje de grupo, **nunca responde**. Solo reporta al webhook para que Odoo/n8n lo registre si deseas.

## Base de datos recomendada

Para producción, PostgreSQL es la opción correcta:

- permite configuración centralizada;
- evita depender de `.env`;
- sirve para logs;
- permite migrar auth state de Baileys en una siguiente versión.

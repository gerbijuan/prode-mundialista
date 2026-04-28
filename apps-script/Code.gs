function doPost(e) {
  try {
    var payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var expectedToken = PropertiesService.getScriptProperties().getProperty('PRODE_SHARED_TOKEN');
    if (!expectedToken || payload.token !== expectedToken) {
      return jsonResponse({ ok: false, error: 'unauthorized' });
    }

    var notifications = Array.isArray(payload.notifications) ? payload.notifications : [];
    var remaining = MailApp.getRemainingDailyQuota();
    var sent = 0;
    var skipped = 0;

    notifications.forEach(function(item) {
      if (!item || !item.to || !item.subject) {
        skipped += 1;
        return;
      }
      if (sent >= remaining) {
        skipped += 1;
        return;
      }
      MailApp.sendEmail(item.to, item.subject, item.text || '', {
        htmlBody: item.html || undefined,
        name: item.name || 'El Prode Mundialista'
      });
      sent += 1;
    });

    return jsonResponse({ ok: true, sent: sent, skipped: skipped, remainingAfter: MailApp.getRemainingDailyQuota() });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error) });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function setSharedToken() {
  // Ejecuta esta función una vez y reemplaza el valor por tu token.
  PropertiesService.getScriptProperties().setProperty('PRODE_SHARED_TOKEN', 'REEMPLAZA_ESTE_TOKEN');
}

function testMail() {
  MailApp.sendEmail(Session.getActiveUser().getEmail(), 'Prueba Prode Mundialista', 'Si te llegó este correo, Apps Script ya puede enviar usando tu cuenta Gmail.');
}

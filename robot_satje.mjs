import { chromium } from 'playwright';
import fs from 'fs';

// Lista de expedientes a vigilar diariamente
const CAUSAS = JSON.parse(fs.readFileSync('./causas.json', 'utf8'));

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
  });
  const context = await browser.newContext({
    locale: 'es-EC',
    timezoneId: 'America/Guayaquil',
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  const resultados = [];

  for (const numeroCausa of CAUSAS) {
    const respuestasCapturadas = [];
    const onResponse = async (response) => {
      const url = response.url();
      if (
        (url.includes('funcionjudicial.gob.ec') || url.includes('EXPEL-')) &&
        !url.includes('/catalogo/') &&
        !url.includes('/ubicacion/') &&
        !url.endsWith('.js') &&
        !url.endsWith('.css')
      ) {
        try {
          const text = await response.text();
          if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
            respuestasCapturadas.push({
              url,
              status: response.status(),
              body: JSON.parse(text)
            });
          }
        } catch (_) {}
      }
    };

    page.on('response', onResponse);

    try {
      await page.goto('https://procesosjudiciales.funcionjudicial.gob.ec/busqueda', {
        waitUntil: 'networkidle',
        timeout: 45000
      });
      await page.waitForTimeout(2000);

      // Paso 1: Clic en "Búsqueda avanzada"
      const btnAvanzada = page.getByText(/Búsqueda avanzada/i).first();
      await btnAvanzada.waitFor({ state: 'visible', timeout: 15000 });
      await btnAvanzada.click({ force: true });
      await page.waitForTimeout(2000);

      // Paso 2: Pegar el número de proceso en el campo oficial numeroCausa
      const inputProceso = page.locator('input[formcontrolname="numeroCausa"]').first();
      await inputProceso.waitFor({ state: 'visible', timeout: 15000 });
      await inputProceso.click();
      await page.evaluate((texto) => {
        const el = document.querySelector('input[formcontrolname="numeroCausa"]');
        if (!el) return;
        el.focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', texto);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        el.value = texto;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }, numeroCausa);
      const valorEscrito = await inputProceso.inputValue().catch(() => '');
      await page.waitForTimeout(1000);

      // Inspeccionar qué controles Angular siguen marcados como inválidos (ej. recaptcha)
      const camposInvalidos = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.ng-invalid[formcontrolname]')).map(el => ({
          campo: el.getAttribute('formcontrolname'),
          valor: el.value ?? ''
        }))
      );

      // Paso 3: Clic en el botón BUSCAR visible del formulario
      const btnBuscar = page.locator('button:visible:has-text("BUSCAR")').first();
      await btnBuscar.click({ force: true });
      await page.waitForTimeout(8000);

      // Si hay resultados, abrir el detalle para extraer actuaciones
      const linkDetalle = page.locator('a[href*="movimientos"], button[aria-label*="movimiento" i], table tbody tr, mat-row, .causa-item').first();
      if (await linkDetalle.isVisible({ timeout: 3000 }).catch(() => false)) {
        await linkDetalle.click({ force: true }).catch(() => {});
        await page.waitForTimeout(5000);
      }

      const textoPantalla = await page.evaluate(() => document.body.innerText.slice(0, 5000));
      const tieneIframeCaptcha = await page.locator('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i]').count() > 0;
      const requiereCaptcha = tieneIframeCaptcha || camposInvalidos.some(c => /captcha/i.test(c.campo || ''));

      resultados.push({
        numeroCausa,
        valorEscrito,
        camposInvalidos,
        requiereCaptcha,
        ok: respuestasCapturadas.length > 0 || (textoPantalla.includes(numeroCausa) && !textoPantalla.includes('El formulario contiene errores')),
        tituloPagina: await page.title(),
        fechaRevision: new Date().toISOString(),
        data: respuestasCapturadas.length > 0 ? respuestasCapturadas : null,
        resumenPantalla: textoPantalla
      });
    } catch (err) {
      resultados.push({
        numeroCausa,
        ok: false,
        error: err.message,
        fechaRevision: new Date().toISOString()
      });
    } finally {
      page.off('response', onResponse);
    }
  }

  fs.writeFileSync('./resultados_satje.json', JSON.stringify({ actualizado: new Date().toISOString(), resultados }, null, 2));
  await browser.close();
})();

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
        waitUntil: 'domcontentloaded',
        timeout: 45000
      });
      await page.waitForTimeout(3000);

      // Paso 1: Entrar a "Búsqueda avanzada"
      const btnAvanzada = page.getByText(/Búsqueda avanzada/i).first();
      await btnAvanzada.waitFor({ state: 'visible', timeout: 20000 });
      await btnAvanzada.click({ force: true });
      await page.waitForTimeout(2500);

      // Paso 2: Localizar directamente el campo oficial Angular formcontrolname="numeroCausa" y pegar el número completo
      const inputProceso = page.locator('input[formcontrolname="numeroCausa"]').first();
      await inputProceso.waitFor({ state: 'visible', timeout: 15000 });
      await inputProceso.click();
      await inputProceso.fill(numeroCausa);
      await inputProceso.dispatchEvent('input');
      await inputProceso.dispatchEvent('change');
      await inputProceso.press('Tab');
      const valorEscrito = await inputProceso.inputValue().catch(() => '');
      await page.waitForTimeout(1200);

      // Paso 3: Hacer clic en BUSCAR dentro del formulario avanzado
      const btnBuscar = page.locator('button[type="submit"], button:has-text("BUSCAR")').last();
      await btnBuscar.click({ force: true });

      // Esperamos 9 segundos a que responda el API del SATJE y renderice resultados
      await page.waitForTimeout(9000);

      // Si aparece una fila o botón para ver el detalle/movimientos del proceso, hacemos clic para abrir actuaciones
      const linkDetalle = page.locator('a[href*="movimientos"], button[aria-label*="movimiento" i], table tbody tr, mat-row, .causa-item').first();
      if (await linkDetalle.isVisible({ timeout: 3000 }).catch(() => false)) {
        await linkDetalle.click({ force: true }).catch(() => {});
        await page.waitForTimeout(5000);
      }

      // Extraemos también el texto visible de la pantalla y posibles mensajes mat-error
      const erroresCampo = await page.locator('mat-error').allInnerTexts().catch(() => []);
      const textoPantalla = await page.evaluate(() => document.body.innerText.slice(0, 5000));
      const tituloPagina = await page.title();

      resultados.push({
        numeroCausa,
        valorEscrito,
        erroresCampo,
        ok: respuestasCapturadas.length > 0 || (textoPantalla.includes(numeroCausa) && !textoPantalla.includes('El formulario contiene errores')),
        tituloPagina,
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

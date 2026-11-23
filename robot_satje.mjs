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
    const onResponse = async (res) => {
      try {
        const u = res.url();
        if (res.status() === 200 && (u.includes('funcionjudicial.gob.ec') && (u.includes('EXPEL') || u.includes('causa') || u.includes('Causa') || u.includes('actuacion')))) {
          const ct = res.headers()['content-type'] || '';
          if (ct.includes('application/json')) {
            const body = await res.json();
            respuestasCapturadas.push({ url: u, body });
          }
        }
      } catch (_) {}
    };

    page.on('response', onResponse);

    try {
      await page.goto('https://procesosjudiciales.funcionjudicial.gob.ec/busqueda', {
        waitUntil: 'networkidle',
        timeout: 60000
      });
      await page.waitForTimeout(3000);

      // Paso 1: Hacer clic en "Búsqueda avanzada" (Angular Material button / span / card)
      const btnAvanzada = page.getByText(/Búsqueda avanzada/i).first();
      await btnAvanzada.waitFor({ state: 'visible', timeout: 15000 });
      await btnAvanzada.click({ force: true });
      await page.waitForTimeout(3000);

      // Paso 2: Ubicar exactamente el cuadro en blanco debajo de "Número de proceso"
      let inputCausa = page.locator('mat-form-field:has-text("Número de proceso") input').first();
      if (!(await inputCausa.isVisible({ timeout: 4000 }).catch(() => false))) {
        inputCausa = page.getByLabel(/Número de proceso/i).last();
      }
      if (!(await inputCausa.isVisible({ timeout: 4000 }).catch(() => false))) {
        inputCausa = page.locator('input[formcontrolname*="proceso" i], input[formcontrolname*="numero" i], input[id*="mat-input"]').first();
      }

      await inputCausa.waitFor({ state: 'visible', timeout: 20000 });
      await inputCausa.click({ clickCount: 3 });
      await inputCausa.press('Backspace');
      // Escribimos tecla por tecla para que Angular Material valide el formulario correctamente
      await inputCausa.pressSequentially(numeroCausa, { delay: 55 });
      await inputCausa.press('Tab');
      await page.waitForTimeout(1000);
      const valorEscrito = await inputCausa.inputValue().catch(() => '');

      // Paso 3: Hacer clic en BUSCAR dentro del formulario avanzado
      const btnBuscar = page.locator('button:has-text("BUSCAR"), button:has-text("Buscar")').last();
      await btnBuscar.click({ force: true });

      // Esperamos 9 segundos a que responda el API del SATJE y renderice resultados
      await page.waitForTimeout(9000);

      // Si aparece una fila o botón para ver el detalle/movimientos del proceso, hacemos clic para abrir actuaciones
      const linkDetalle = page.locator('a[href*="movimientos"], button[aria-label*="movimiento" i], table tbody tr, mat-row, .causa-item').first();
      if (await linkDetalle.isVisible({ timeout: 3000 }).catch(() => false)) {
        await linkDetalle.click({ force: true }).catch(() => {});
        await page.waitForTimeout(5000);
      }

      // Extraemos también el texto visible de la pantalla
      const textoPantalla = await page.evaluate(() => document.body.innerText.slice(0, 5000));
      const tituloPagina = await page.title();

      resultados.push({
        numeroCausa,
        valorEscrito,
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

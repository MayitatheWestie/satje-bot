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
      await page.waitForTimeout(2000);

      // Paso 2: Ubicar exactamente los inputs dentro del bloque "Número de proceso"
      const bloqueNumero = page.locator('div, section, form').filter({ hasText: /^Número de proceso/i }).first();
      const inputsEnBloque = bloqueNumero.locator('input:visible');
      const cantidadInputs = await inputsEnBloque.count().catch(() => 0);

      let valorEscrito = '';
      if (cantidadInputs >= 3) {
        // Caso A: El SATJE divide el número de proceso en 3 cajitas (Dependencia - Año - Secuencial)
        const partes = numeroCausa.replace(/[^0-9]/g, '');
        const p1 = numeroCausa.includes('-') ? numeroCausa.split('-')[0] : partes.slice(0, 5);
        const p2 = numeroCausa.includes('-') ? numeroCausa.split('-')[1] : partes.slice(5, 9);
        const p3 = numeroCausa.includes('-') ? numeroCausa.split('-')[2] : partes.slice(9);

        await inputsEnBloque.nth(0).click();
        await inputsEnBloque.nth(0).pressSequentially(p1, { delay: 45 });
        await inputsEnBloque.nth(1).click();
        await inputsEnBloque.nth(1).pressSequentially(p2, { delay: 45 });
        await inputsEnBloque.nth(2).click();
        await inputsEnBloque.nth(2).pressSequentially(p3, { delay: 45 });
        await inputsEnBloque.nth(2).press('Tab');
        valorEscrito = `${p1}-${p2}-${p3} (3 campos)`;
      } else {
        // Caso B: 1 solo campo de texto
        let inputCausa = page.locator('mat-form-field:has-text("Número de proceso") input').first();
        if (!(await inputCausa.isVisible({ timeout: 4000 }).catch(() => false))) {
          inputCausa = page.getByLabel(/Número de proceso/i).last();
        }
        await inputCausa.waitFor({ state: 'visible', timeout: 20000 });
        await inputCausa.click({ clickCount: 3 });
        await inputCausa.press('Backspace');
        await inputCausa.pressSequentially(numeroCausa, { delay: 55 });
        await inputCausa.press('Tab');
        valorEscrito = await inputCausa.inputValue().catch(() => '');
      }
      await page.waitForTimeout(1000);

      // Paso 3: Hacer clic en BUSCAR dentro del formulario avanzado
      let btnBuscar = page.locator('button:has-text("BUSCAR"), button:has-text("Buscar")').last();
      await btnBuscar.click({ force: true });
      await page.waitForTimeout(3000);

      // Si el portal rechazó los guiones en campo único, reintentamos sin guiones (17230202404819)
      const huboErrorForm = await page.getByText(/El formulario contiene errores/i).isVisible().catch(() => false);
      if (huboErrorForm && cantidadInputs < 3) {
        const soloDigitos = numeroCausa.replace(/[^0-9]/g, '');
        const inputRetry = page.locator('mat-form-field:has-text("Número de proceso") input').first();
        await inputRetry.click({ clickCount: 3 });
        await inputRetry.press('Backspace');
        await inputRetry.pressSequentially(soloDigitos, { delay: 55 });
        await inputRetry.press('Tab');
        valorEscrito = soloDigitos;
        await btnBuscar.click({ force: true });
      }

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

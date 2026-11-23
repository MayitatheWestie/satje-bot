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

      // Paso 2: Inspeccionar todos los inputs visibles de la página y localizar los de "Número de proceso"
      const infoInputs = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input')).filter(el => el.offsetParent !== null);
        return inputs.map((el, idx) => {
          const rect = el.getBoundingClientRect();
          const field = el.closest('mat-form-field');
          const labelText = field ? field.innerText.replace(/\s+/g, ' ').trim() : '';
          return {
            idx,
            y: Math.round(rect.top),
            x: Math.round(rect.left),
            maxLength: el.maxLength,
            placeholder: el.placeholder || '',
            formControlName: el.getAttribute('formcontrolname') || '',
            ariaLabel: el.getAttribute('aria-label') || '',
            labelText
          };
        });
      });

      const todosLosInputs = page.locator('input:visible');
      // Los inputs de "Número de proceso" son los que tienen label "Número de proceso" o están en la primera fila (menor Y)
      let inputsProceso = infoInputs.filter(i => /número de proceso/i.test(i.labelText));
      if (inputsProceso.length === 0 && infoInputs.length > 0) {
        const minY = Math.min(...infoInputs.map(i => i.y));
        inputsProceso = infoInputs.filter(i => Math.abs(i.y - minY) <= 18);
      }

      let valorEscrito = '';
      if (inputsProceso.length >= 3) {
        // 3 cajitas separadas (Dependencia - Año - Secuencial)
        const partes = numeroCausa.replace(/[^0-9]/g, '');
        const p1 = numeroCausa.includes('-') ? numeroCausa.split('-')[0] : partes.slice(0, 5);
        const p2 = numeroCausa.includes('-') ? numeroCausa.split('-')[1] : partes.slice(5, 9);
        const p3 = numeroCausa.includes('-') ? numeroCausa.split('-')[2] : partes.slice(9);

        await todosLosInputs.nth(inputsProceso[0].idx).click();
        await todosLosInputs.nth(inputsProceso[0].idx).pressSequentially(p1, { delay: 45 });
        await todosLosInputs.nth(inputsProceso[1].idx).click();
        await todosLosInputs.nth(inputsProceso[1].idx).pressSequentially(p2, { delay: 45 });
        await todosLosInputs.nth(inputsProceso[2].idx).click();
        await todosLosInputs.nth(inputsProceso[2].idx).pressSequentially(p3, { delay: 45 });
        await todosLosInputs.nth(inputsProceso[2].idx).press('Tab');
        valorEscrito = `${p1}-${p2}-${p3} (3 cajas)`;
      } else if (inputsProceso.length >= 1) {
        const target = todosLosInputs.nth(inputsProceso[0].idx);
        await target.click({ clickCount: 3 });
        await target.press('Backspace');
        await target.pressSequentially(numeroCausa, { delay: 55 });
        await target.press('Tab');
        valorEscrito = await target.inputValue().catch(() => '');
      }
      await page.waitForTimeout(1000);

      // Paso 3: Hacer clic en BUSCAR dentro del formulario avanzado
      const btnBuscar = page.locator('button:has-text("BUSCAR"), button:has-text("Buscar")').last();
      await btnBuscar.click({ force: true });
      await page.waitForTimeout(3000);

      // Si el portal rechazó los guiones en campo único, reintentamos sin guiones
      const huboErrorForm = await page.getByText(/El formulario contiene errores/i).isVisible().catch(() => false);
      if (huboErrorForm && inputsProceso.length === 1) {
        const soloDigitos = numeroCausa.replace(/[^0-9]/g, '');
        const targetRetry = todosLosInputs.nth(inputsProceso[0].idx);
        await targetRetry.click({ clickCount: 3 });
        await targetRetry.press('Backspace');
        await targetRetry.pressSequentially(soloDigitos, { delay: 55 });
        await targetRetry.press('Tab');
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
        camposDetectados: infoInputs.slice(0, 5),
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

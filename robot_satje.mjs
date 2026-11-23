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
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
      await page.waitForTimeout(3500);

      // Paso 1: Hacer clic en "Búsqueda avanzada"
      const btnAvanzada = page.locator('a:has-text("Búsqueda avanzada"), button:has-text("Búsqueda avanzada"), a:has-text("Búsqueda Avanzada"), button:has-text("Búsqueda Avanzada"), [role="tab"]:has-text("avanzada")').first();
      if (await btnAvanzada.isVisible({ timeout: 10000 }).catch(() => false)) {
        await btnAvanzada.click();
        await page.waitForTimeout(2500);
      }

      // Paso 2: Ubicar el campo "Número de proceso"
      let inputCausa = page.getByLabel(/n[uú]mero de proceso/i).first();
      if (!(await inputCausa.isVisible({ timeout: 4000 }).catch(() => false))) {
        inputCausa = page.locator('input[placeholder*="proceso" i], input[formcontrolname*="proceso" i], input[formcontrolname*="causa" i], input[name*="proceso" i]').first();
      }
      if (!(await inputCausa.isVisible({ timeout: 4000 }).catch(() => false))) {
        inputCausa = page.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])').first();
      }

      await inputCausa.waitFor({ state: 'visible', timeout: 20000 });
      await inputCausa.fill(numeroCausa);
      await page.waitForTimeout(1000);

      // Paso 3: Hacer clic en Buscar o presionar Enter
      const btnBuscar = page.locator('button:has-text("Buscar"), button[type="submit"]').first();
      if (await btnBuscar.isVisible().catch(() => false)) {
        await btnBuscar.click();
      } else {
        await inputCausa.press('Enter');
      }

      // Esperamos 8 segundos a que cargue la respuesta del SATJE y las actuaciones
      await page.waitForTimeout(8000);

      // Extraemos también el texto visible de la tabla/tarjetas por si el portal renderiza en DOM
      const textoPantalla = await page.evaluate(() => document.body.innerText.slice(0, 4000));
      const tituloPagina = await page.title();

      resultados.push({
        numeroCausa,
        ok: respuestasCapturadas.length > 0 || textoPantalla.includes(numeroCausa),
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

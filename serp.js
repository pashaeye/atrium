// Content script (top frame). On Google search results in an Incognito window, a small panel in the
// bottom-right corner lets you pick the country Google searches from (the gl parameter) and the language
// of the interface and results (hl), plus a button for a full-page screenshot of the results.
// The choice is remembered and applied to the next Incognito searches too, until set back to "Default".
// Runs only when the extension is allowed in Incognito, and only on Google's /search pages.
(() => {
  if (window.__spacesSerp) return;
  window.__spacesSerp = true;
  let incognito = false;
  try { incognito = !!chrome.extension?.inIncognitoContext; } catch { /* extension reloaded */ }
  if (!incognito) return;
  if (!/^(www\.)?google\.[a-z.]+$/.test(location.hostname) || location.pathname !== '/search') return;

  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

  // Every country Google accepts in gl (ISO 3166-1 alpha-2), named in English by the browser.
  const COUNTRIES = ('AF AX AL DZ AS AD AO AI AQ AG AR AM AW AU AT AZ BS BH BD BB BY BE BZ BJ BM BT BO BQ BA BW BV BR IO BN BG BF BI CV KH CM CA KY CF TD CL CN CX CC CO KM CG CD CK CR CI HR CU CW CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FK FO FJ FI FR GF PF TF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HM VA HN HK HU IS IN ID IR IQ IE IM IL IT JM JP JE JO KZ KE KI KP KR KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MQ MR MU YT MX FM MD MC MN ME MS MA MZ MM NA NR NP NL NC NZ NI NE NG NU NF MK MP NO OM PK PW PS PA PG PY PE PH PN PL PT PR QA RE RO RU RW BL SH KN LC MF PM VC WS SM ST SA SN RS SC SL SG SX SK SI SB SO ZA GS SS ES LK SD SR SJ SE CH SY TW TJ TZ TH TL TG TK TO TT TN TR TM TC TV UG UA AE GB US UM UY UZ VU VE VN VG VI WF EH YE ZM ZW').split(' ');
  // Google's interface languages (hl), without the joke ones (Pirate, Klingon…).
  const LANGUAGES = ('af ak sq am ar hy az eu be bem bn bh bs br bg km ca chr ny zh-CN zh-TW co hr cs da nl en eo et ee fo tl fi fr fy gaa gl ka de el gn gu ht ha haw iw hi hu is ig id ia ga it ja jw kn kk rw rn kg ko kri ku ckb ky lo la lv ln lt loz lg ach mk mg ms ml mt mi mr mfe mo mn sr-ME ne pcm nso no nn oc or om ps fa pl pt-BR pt-PT pa qu ro rm nyn ru gd sr sh st tn crs sn sd si sk sl so es es-419 su sw sv tg ta tt te th ti to lua tum tr tk tw ug uk ur uz vi cy wo xh yi yo zu').split(' ');
  // Google's old codes that the browser doesn't name by itself.
  const LANG_FIX = { iw: 'he', jw: 'jv', mo: 'ro-MD', sh: 'sr-Latn', 'sr-ME': 'sr-Latn-ME', bh: 'bho', 'es-419': 'es-419' };
  // …and a few the browser has no English name for.
  const LANG_NAMES = { bem: 'Bemba', gaa: 'Ga', rn: 'Kirundi', kg: 'Kongo', loz: 'Lozi', ach: 'Acholi', mfe: 'Mauritian Creole',
    pcm: 'Nigerian Pidgin', nyn: 'Runyankore', crs: 'Seychellois Creole', lua: 'Tshiluba', tum: 'Tumbuka' };
  const regionName = (() => { try { const d = new Intl.DisplayNames(['en'], { type: 'region' }); return (c) => d.of(c) || c; } catch { return (c) => c; } })();
  const langName = (() => {
    try {
      const d = new Intl.DisplayNames(['en'], { type: 'language' });
      return (c) => { if (LANG_NAMES[c]) return LANG_NAMES[c]; try { return d.of(LANG_FIX[c] || c) || c; } catch { return c; } };
    } catch { return (c) => LANG_NAMES[c] || c; }
  })();
  const countries = COUNTRIES.map((c) => [c.toLowerCase(), regionName(c)]).sort((a, b) => a[1].localeCompare(b[1]));
  const languages = LANGUAGES.map((c) => [c, langName(c)]).sort((a, b) => a[1].localeCompare(b[1]));

  const url = new URL(location.href);
  const current = { gl: (url.searchParams.get('gl') || '').toLowerCase(), hl: url.searchParams.get('hl') || '' };

  // Largest cities of the top-20 countries, in Google Ads' "canonical name" form (City,Region,Country),
  // which is what the uule parameter carries. Google ignores a name it doesn't recognise.
  const CITIES = {
    us: ['New York,New York,United States', 'Los Angeles,California,United States', 'Chicago,Illinois,United States', 'Houston,Texas,United States', 'Phoenix,Arizona,United States', 'Philadelphia,Pennsylvania,United States', 'San Antonio,Texas,United States', 'San Diego,California,United States', 'Dallas,Texas,United States', 'San Francisco,California,United States', 'Seattle,Washington,United States', 'Miami,Florida,United States', 'Boston,Massachusetts,United States', 'Washington,District of Columbia,United States', 'Austin,Texas,United States', 'Denver,Colorado,United States', 'Atlanta,Georgia,United States', 'Las Vegas,Nevada,United States'],
    cn: ['Beijing,Beijing,China', 'Shanghai,Shanghai,China', 'Guangzhou,Guangdong,China', 'Shenzhen,Guangdong,China', 'Chengdu,Sichuan,China', 'Hangzhou,Zhejiang,China', 'Wuhan,Hubei,China', 'Chongqing,Chongqing,China'],
    de: ['Berlin,Berlin,Germany', 'Hamburg,Hamburg,Germany', 'Munich,Bavaria,Germany', 'Cologne,North Rhine-Westphalia,Germany', 'Frankfurt,Hesse,Germany', 'Stuttgart,Baden-Wurttemberg,Germany', 'Dusseldorf,North Rhine-Westphalia,Germany', 'Leipzig,Saxony,Germany'],
    jp: ['Tokyo,Tokyo,Japan', 'Osaka,Osaka,Japan', 'Yokohama,Kanagawa,Japan', 'Nagoya,Aichi,Japan', 'Sapporo,Hokkaido,Japan', 'Fukuoka,Fukuoka,Japan', 'Kyoto,Kyoto,Japan', 'Kobe,Hyogo,Japan'],
    in: ['Mumbai,Maharashtra,India', 'Delhi,Delhi,India', 'Bengaluru,Karnataka,India', 'Hyderabad,Telangana,India', 'Chennai,Tamil Nadu,India', 'Kolkata,West Bengal,India', 'Pune,Maharashtra,India', 'Ahmedabad,Gujarat,India'],
    gb: ['London,England,United Kingdom', 'Manchester,England,United Kingdom', 'Birmingham,England,United Kingdom', 'Leeds,England,United Kingdom', 'Glasgow,Scotland,United Kingdom', 'Liverpool,England,United Kingdom', 'Edinburgh,Scotland,United Kingdom', 'Bristol,England,United Kingdom'],
    fr: ['Paris,Ile-de-France,France', 'Marseille,Provence-Alpes-Cote d\'Azur,France', 'Lyon,Auvergne-Rhone-Alpes,France', 'Toulouse,Occitanie,France', 'Nice,Provence-Alpes-Cote d\'Azur,France', 'Nantes,Pays de la Loire,France', 'Bordeaux,Nouvelle-Aquitaine,France', 'Lille,Hauts-de-France,France'],
    it: ['Rome,Lazio,Italy', 'Milan,Lombardy,Italy', 'Naples,Campania,Italy', 'Turin,Piedmont,Italy', 'Florence,Tuscany,Italy', 'Bologna,Emilia-Romagna,Italy', 'Palermo,Sicily,Italy'],
    ca: ['Toronto,Ontario,Canada', 'Montreal,Quebec,Canada', 'Vancouver,British Columbia,Canada', 'Calgary,Alberta,Canada', 'Ottawa,Ontario,Canada', 'Edmonton,Alberta,Canada'],
    br: ['Sao Paulo,State of Sao Paulo,Brazil', 'Rio de Janeiro,State of Rio de Janeiro,Brazil', 'Brasilia,Federal District,Brazil', 'Salvador,State of Bahia,Brazil', 'Belo Horizonte,State of Minas Gerais,Brazil', 'Curitiba,State of Parana,Brazil'],
    ru: ['Moscow,Moscow,Russia', 'Saint Petersburg,Saint Petersburg,Russia', 'Novosibirsk,Novosibirsk Oblast,Russia', 'Yekaterinburg,Sverdlovsk Oblast,Russia', 'Kazan,Republic of Tatarstan,Russia'],
    mx: ['Mexico City,Mexico City,Mexico', 'Guadalajara,Jalisco,Mexico', 'Monterrey,Nuevo Leon,Mexico', 'Puebla,Puebla,Mexico', 'Tijuana,Baja California,Mexico', 'Cancun,Quintana Roo,Mexico'],
    au: ['Sydney,New South Wales,Australia', 'Melbourne,Victoria,Australia', 'Brisbane,Queensland,Australia', 'Perth,Western Australia,Australia', 'Adelaide,South Australia,Australia'],
    kr: ['Seoul,Seoul,South Korea', 'Busan,Busan,South Korea', 'Incheon,Incheon,South Korea'],
    es: ['Madrid,Community of Madrid,Spain', 'Barcelona,Catalonia,Spain', 'Valencia,Valencian Community,Spain', 'Seville,Andalusia,Spain', 'Malaga,Andalusia,Spain'],
    id: ['Jakarta,Jakarta,Indonesia', 'Surabaya,East Java,Indonesia', 'Bandung,West Java,Indonesia'],
    nl: ['Amsterdam,North Holland,Netherlands', 'Rotterdam,South Holland,Netherlands', 'The Hague,South Holland,Netherlands', 'Utrecht,Utrecht,Netherlands', 'Eindhoven,North Brabant,Netherlands', 'Groningen,Groningen,Netherlands'],
    tr: ['Istanbul,Istanbul,Turkey', 'Ankara,Ankara,Turkey', 'Izmir,Izmir,Turkey', 'Antalya,Antalya,Turkey'],
    sa: ['Riyadh,Riyadh Province,Saudi Arabia', 'Jeddah,Makkah Province,Saudi Arabia', 'Mecca,Makkah Province,Saudi Arabia'],
    ch: ['Zurich,Zurich,Switzerland', 'Geneva,Geneva,Switzerland', 'Basel,Basel-City,Switzerland', 'Bern,Bern,Switzerland', 'Lausanne,Vaud,Switzerland'],
  };
  /** uule = "w+CAIQICI" + a letter for the name's length + the name in base64. */
  const UULE_KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function uule(name) {
    const bytes = new TextEncoder().encode(name);
    return `w+CAIQICI${UULE_KEY[bytes.length % 64]}${btoa(String.fromCharCode(...bytes)).replace(/=+$/, '')}`;
  }
  // In the query a literal "+" reads back as a space: "w CAIQ…" is the same uule.
  const cityOfUule = (gl, value) => (CITIES[gl] || []).find((c) => uule(c) === (value || '').replace(/^w /, 'w+')) || '';

  /** Reload this search with the given country / language / city ('' = Google's default). */
  function go({ gl, hl, city = '' }) {
    const u = new URL(location.href);
    gl ? u.searchParams.set('gl', gl) : u.searchParams.delete('gl');
    hl ? u.searchParams.set('hl', hl) : u.searchParams.delete('hl');
    u.searchParams.delete('uule');
    // uule goes in as Google writes it: a literal "+" after the "w" (not %2B), the rest URL-encoded.
    if (city && (CITIES[gl] || []).includes(city)) u.search += `&uule=w+${encodeURIComponent(uule(city).slice(2))}`;
    u.searchParams.delete('start'); // back to the first page of results
    if (u.href !== location.href) location.assign(u.href);
  }

  // A remembered choice is applied to searches that don't say otherwise. Until you pick something,
  // Incognito searches go out as from the US, in English ("Any" in a picker means Google's own default).
  const DEFAULT_LOCALE = { gl: 'us', hl: 'en' };
  const ready = alive()
    ? chrome.storage.local.get('serpLocale').then((r) => r.serpLocale || DEFAULT_LOCALE).catch(() => DEFAULT_LOCALE)
    : Promise.resolve(DEFAULT_LOCALE);
  ready.then((saved) => {
    const want = {
      gl: url.searchParams.has('gl') ? current.gl : saved.gl || '',
      hl: url.searchParams.has('hl') ? current.hl : saved.hl || '',
    };
    want.city = url.searchParams.has('uule')
      ? cityOfUule(want.gl, url.searchParams.get('uule'))
      : saved.gl === want.gl ? saved.city || '' : '';
    if ((want.gl && !url.searchParams.has('gl')) || (want.hl && !url.searchParams.has('hl')) || (want.city && !url.searchParams.has('uule'))) return go(want);
    const proxy = alive() ? chrome.runtime.sendMessage({ type: 'proxyGet' }).catch(() => null) : Promise.resolve(null);
    proxy.then((p) => mount(want, p));
  });

  // Which IP Google sees: yours, a free public proxy in the picked country, or your own proxy
  // (see "proxy for Incognito windows only" in background.js).
  function proxyOptions(p) {
    const mode = p?.conf?.mode || 'off';
    const cc = (p?.state?.country || p?.conf?.country || 'us').toUpperCase();
    const o = (v, label, sel = false) => `<option value="${v}"${sel ? ' selected' : ''}>${label}</option>`;
    return o('off', 'Your IP', mode === 'off')
      + o('free', `Free proxy${mode === 'free' ? ` · ${cc}` : ''}`, mode === 'free')
      + (mode === 'free' ? o('next', 'Try another free proxy') : '')
      + (p?.conf?.hasOwn ? o('own', 'Your proxy', mode === 'own') : '')
      + o('setup', p?.conf?.hasOwn ? 'Proxy settings…' : 'Set up your proxy…');
  }
  function proxyTip(p) {
    const st = p?.state || {};
    if (st.error) return st.error;
    if (st.mode === 'free') return `Google sees a free proxy: ${st.server} (${st.tried} of ${st.of}). Slow and unreliable; fine for checking results, not for signing in.`;
    if (st.mode === 'own') return `Google sees your proxy: ${st.server}`;
    return 'Google sees your own IP address (ads follow it). Pick a proxy to search from another country.';
  }

  // On top of each list: the 20 largest economies (by GDP) and the most used languages, then everything A–Z.
  const TOP_COUNTRIES = ['us', 'cn', 'de', 'jp', 'in', 'gb', 'fr', 'it', 'ca', 'br', 'ru', 'mx', 'au', 'kr', 'es', 'id', 'nl', 'tr', 'sa', 'ch'];
  const TOP_LANGUAGES = ['en', 'es', 'zh-CN', 'hi', 'ar', 'pt-BR', 'fr', 'de', 'ru', 'ja', 'ko', 'it', 'tr', 'id', 'nl', 'pl'];

  function options(list, top, topLabel, allLabel, value, none) {
    const byCode = new Map(list);
    let picked = false;
    const opt = (code, name) => {
      const sel = !picked && code === value;
      if (sel) picked = true;
      return `<option value="${code}"${sel ? ' selected' : ''}>${name}</option>`;
    };
    return `<option value="">${none}</option>`
      + `<optgroup label="${topLabel}">${top.filter((c) => byCode.has(c)).map((c) => opt(c, byCode.get(c))).join('')}</optgroup>`
      + `<optgroup label="${allLabel}">${list.map(([code, name]) => opt(code, name)).join('')}</optgroup>`;
  }

  function cityOptions(gl, value) {
    return '<option value="">Any city</option>' + CITIES[gl].map((c) => `<option value="${c.replace(/"/g, '&quot;')}"${c === value ? ' selected' : ''}>${c.split(',')[0]}</option>`).join('');
  }

  let host = null;
  function mount(sel, proxyInfo = null) {
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483645;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
        :host { all: initial; }
        * { box-sizing: border-box; font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
        .bar {
          display: flex; align-items: center; gap: 6px; padding: 6px; border-radius: 14px; color: #fff;
          background: rgba(46, 30, 92, 0.92); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
          box-shadow: 0 0 0 0.5px rgba(255,255,255,.12), 0 10px 30px rgba(0,0,0,.3);
        }
        .label { padding: 0 4px 0 6px; font-weight: 650; opacity: .85; white-space: nowrap; }
        select {
          appearance: none; -webkit-appearance: none; border: 0; border-radius: 9px; padding: 6px 24px 6px 9px; max-width: 150px;
          color: #fff; background: rgba(255,255,255,.12) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='white' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 8px center;
          cursor: pointer;
        }
        select:hover { background-color: rgba(255,255,255,.2); }
        select:focus { outline: 2px solid rgba(255,255,255,.4); outline-offset: 0; }
        option { color: #111; background: #fff; }
        button {
          all: unset; cursor: pointer; width: 30px; height: 28px; border-radius: 9px; display: grid; place-items: center;
          background: rgba(255,255,255,.12);
        }
        button:hover { background: rgba(255,255,255,.2); }
        svg { width: 15px; height: 15px; display: block; }
      </style>
      <div class="bar">
        <span class="label">Google as</span>
        <select data-k="gl" title="Country Google searches from (gl)">${options(countries, TOP_COUNTRIES, 'Largest economies', 'All countries', sel.gl, 'Any country')}</select>
        ${CITIES[sel.gl] ? `<select data-k="city" title="City Google searches from (uule): mostly changes local results, maps and “near me”">${cityOptions(sel.gl, sel.city)}</select>` : ''}
        <select data-k="hl" title="Language of Google and its results (hl)">${options(languages, TOP_LANGUAGES, 'Most used', 'All languages', sel.hl, 'Any language')}</select>
        <select data-k="proxy" title="${proxyTip(proxyInfo).replace(/"/g, '&quot;')}">${proxyOptions(proxyInfo)}</select>
        <button data-shot title="Screenshot of the whole results page"><svg viewBox="0 0 256 256" fill="currentColor"><path d="M208,56H180.28L166.65,35.56A8,8,0,0,0,160,32H96a8,8,0,0,0-6.65,3.56L75.71,56H48A24,24,0,0,0,24,80V192a24,24,0,0,0,24,24H208a24,24,0,0,0,24-24V80A24,24,0,0,0,208,56Zm8,136a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V80a8,8,0,0,1,8-8H80a8,8,0,0,0,6.66-3.56L100.28,48h55.43l13.63,20.44A8,8,0,0,0,176,72h32a8,8,0,0,1,8,8ZM128,88a44,44,0,1,0,44,44A44.05,44.05,0,0,0,128,88Zm0,72a28,28,0,1,1,28-28A28,28,0,0,1,128,160Z"/></svg></button>
      </div>`;
    root.querySelector('[data-k=proxy]').addEventListener('change', async (e) => {
      const v = e.target.value;
      if (!alive()) return;
      if (v === 'setup') {
        e.target.value = proxyInfo?.conf?.mode || 'off';
        chrome.runtime.sendMessage({ type: 'proxySetup' }).catch(() => {});
        return;
      }
      e.target.disabled = true;
      const r = v === 'next'
        ? await chrome.runtime.sendMessage({ type: 'proxyNext' }).catch(() => null)
        : await chrome.runtime.sendMessage({ type: 'proxySet', patch: { mode: v, country: root.querySelector('[data-k=gl]').value || 'us' } }).catch(() => null);
      if (r?.error || r?.state?.error) { e.target.disabled = false; e.target.title = r.error || r.state.error; alert(`Proxy: ${r.error || r.state.error}`); return; }
      location.reload(); // the new IP applies to the next request
    });
    root.querySelectorAll('select:not([data-k=proxy])').forEach((s) => s.addEventListener('change', async () => {
      const next = { gl: root.querySelector('[data-k=gl]').value, hl: root.querySelector('[data-k=hl]').value };
      // A new country starts without a city; otherwise keep the picked one.
      next.city = s.dataset.k === 'gl' ? '' : root.querySelector('[data-k=city]')?.value || '';
      if (alive()) chrome.storage.local.set({ serpLocale: next }).catch(() => {});
      // A free proxy follows the country.
      if (s.dataset.k === 'gl' && proxyInfo?.conf?.mode === 'free' && alive()) {
        await chrome.runtime.sendMessage({ type: 'proxySet', patch: { country: next.gl || 'us' } }).catch(() => null);
      }
      go(next);
    }));
    root.querySelector('[data-shot]').addEventListener('click', () => {
      if (!alive()) return;
      chrome.runtime.sendMessage({ type: 'shotSelf', mode: 'full' }).catch(() => {});
    });
    document.documentElement.append(host);
  }

  // Keep the panel out of screenshots: shot.js says when it's open.
  window.addEventListener('message', (e) => {
    if (e.source !== window || !host) return;
    if (e.data?.__spacesShot === 'open') host.style.display = 'none';
    if (e.data?.__spacesShot === 'close') host.style.display = '';
  });
})();

// Vercel Edge Function
export const config = { runtime: 'edge' };

function json(data, init = {}) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'x-robots-tag': 'noindex',
    ...init.headers
  };
  return new Response(JSON.stringify(data), { ...init, headers });
}

function err(message, status = 400) {
  return json({ error: message }, { status });
}

function extractVideoId(input) {
  if (!input) throw new Error('Falta url');
  if (/^[\w-]{11}$/.test(input)) return input;
  let u; try { u = new URL(input); } catch { throw new Error('URL inválida'); }
  if (u.hostname.includes('youtu.be')) {
    const id = u.pathname.split('/').filter(Boolean)[0];
    if (!id) throw new Error('No se pudo extraer el ID');
    return id;
  }
  if (u.hostname.includes('youtube.com')) {
    if (u.pathname === '/watch') {
      const v = u.searchParams.get('v');
      if (v) return v;
    }
    const parts = u.pathname.split('/').filter(Boolean);
    if ((parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') && parts[1]) return parts[1];
  }
  throw new Error('No se pudo extraer el ID');
}

function vttToSegments(vtt) {
  const lines = vtt.split(/\r?\n/);
  const segs = [];
  let buf = [], start = 0, end = 0;

  const toMs = (ts) => {
    const m = ts.trim().match(/(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/);
    if (!m) return 0;
    const h = + (m[1] || 0), mn = +m[2], s = +m[3], ms = +m[4];
    return (((h * 60 + mn) * 60) + s) * 1000 + ms;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line.includes('-->')) {
      if (buf.length) {
        segs.push({ start, end, duration: Math.max(0, end - start), text: buf.join(' ').replace(/\s+/g,' ').trim() });
        buf = [];
      }
      const [a, b] = line.split('-->');
      start = toMs(a); end = toMs(b);
      continue;
    }
    if (line && !/^\d+$/.test(line) && !/^WEBVTT/i.test(line)) {
      buf.push(line.replace(/<[^>]+>/g, ''));
    }
  }
  if (buf.length) segs.push({ start, end, duration: Math.max(0, end - start), text: buf.join(' ').replace(/\s+/g,' ').trim() });
  return segs.filter(s => s.text);
}

async function fetchInnerTubeKey(videoId) {
  const r = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { 'accept-language': 'es-ES,es;q=0.9,en;q=0.8' }
  });
  const html = await r.text();
  const m = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  if (!m) throw new Error('No se encontró INNERTUBE_API_KEY');
  return m[1];
}

function chooseTrack(tracks, langs) {
  const pref = (t) => {
    const lang = (t.languageCode || '').toLowerCase();
    const asr = t.kind === 'asr';
    const rank = langs.findIndex(l => lang.startsWith(l));
    return (asr ? 10 : 0) + (rank === -1 ? 5 : rank);
  };
  return [...tracks].sort((a, b) => pref(a) - pref(b))[0];
}

async function getPlayer(videoId, apiKey) {
  const url = `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`;
  const body = {
    context: { client: { clientName: 'ANDROID', clientVersion: '20.50.37' } },
    videoId
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`player ${r.status}`);
  return r.json();
}

async function downloadVtt(baseUrl, tlang) {
  const u = new URL(baseUrl);
  if (!u.searchParams.has('fmt')) u.searchParams.set('fmt','vtt');
  if (tlang) u.searchParams.set('tlang', tlang); // traducción opcional
  const r = await fetch(u.toString());
  if (!r.ok) throw new Error(`timedtext ${r.status}`);
  return r.text();
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,OPTIONS',
        'access-control-allow-headers': 'content-type'
      }
    });
  }

  try {
    const { searchParams } = new URL(req.url);
    const input = searchParams.get('url');
    const langsParam = (searchParams.get('langs') || 'es,en').toLowerCase();
    const tlang = searchParams.get('tlang') || ''; // si quieres forzar traducción
    const langs = langsParam.split(',').map(s => s.trim()).filter(Boolean);

    const videoId = extractVideoId(input);
    const apiKey = await fetchInnerTubeKey(videoId);
    const player = await getPlayer(videoId, apiKey);

    const tracklist = player?.captions?.playerCaptionsTracklistRenderer;
    const tracks = tracklist?.captionTracks || [];
    if (!tracks.length) return err('El video no expone subtítulos', 404);

    const best = chooseTrack(tracks, langs);
    const vtt = await downloadVtt(best.baseUrl, tlang);
    const segments = vttToSegments(vtt);

    return json({
      videoId,
      language: best.languageCode || 'unknown',
      source: best.kind === 'asr' ? 'innertube (auto-ASR)' : 'innertube (manual)',
      segments
    });
  } catch (e) {
    return err(e.message || 'Error inesperado', 500);
  }
}

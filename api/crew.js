// Proxy for Open Notify's astros endpoint — open-notify.org is HTTP-only,
// so we fetch it server-side and re-serve over HTTPS with CORS.
export default async function handler(req, res) {
  try {
    const upstream = await fetch('http://api.open-notify.org/astros.json');
    if (!upstream.ok) throw new Error('upstream ' + upstream.status);
    const data = await upstream.json();
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: 'crew source unavailable' });
  }
}

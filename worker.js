/**
 * Prism Launcher Meta 镜像代理 Worker
 *
 * 将 https://meta.prismlauncher.org/v1/ 的元数据代理下来，
 * 并把其中的官方下载地址替换为 BMCLAPI 镜像地址。
 *
 * 注意：由于替换了组件元数据 JSON 中的 URL，
 * 这些 JSON 的 sha256 会与根索引/版本索引中记录的不一致，
 * 因此需要删除索引中的 sha1/sha256，否则 Prism 会校验失败。
 */

const REPLACEMENTS = [
  // === Mojang ===
  { regex: /launchermeta\.mojang\.com/g, replacement: 'bmclapi2.bangbang93.com' },
  { regex: /piston-meta\.mojang\.com/g, replacement: 'bmclapi2.bangbang93.com' },
  { regex: /piston-data\.mojang\.com/g, replacement: 'bmclapi2.bangbang93.com' },
  { regex: /launcher\.mojang\.com/g, replacement: 'bmclapi2.bangbang93.com' },
  { regex: /resources\.download\.minecraft\.net/g, replacement: 'bmclapi2.bangbang93.com/assets' },
  { regex: /libraries\.minecraft\.net/g, replacement: 'bmclapi2.bangbang93.com/maven' },

  // === Fabric ===
  { regex: /meta\.fabricmc\.net/g, replacement: 'bmclapi2.bangbang93.com/fabric-meta' },
  { regex: /maven\.fabricmc\.net/g, replacement: 'bmclapi2.bangbang93.com/maven' },

  // === Forge ===
  { regex: /maven\.minecraftforge\.net/g, replacement: 'bmclapi2.bangbang93.com/maven' },
  { regex: /files\.minecraftforge\.net\/maven/g, replacement: 'bmclapi2.bangbang93.com/maven' },

  // === Liteloader ===
  { regex: /dl\.liteloader\.com\/versions\/versions\.json/g, replacement: 'bmclapi2.bangbang93.com/maven/com/mumfrey/liteloader/versions.json' },
  { regex: /dl\.liteloader\.com\/versions/g, replacement: 'bmclapi2.bangbang93.com/maven' },

  // === Neoforge ===
  { regex: /maven\.neoforged\.net\/releases/g, replacement: 'bmclapi2.bangbang93.com/maven' },

  // === Quilt ===
  { regex: /maven\.quiltmc\.org\/repository\/release/g, replacement: 'bmclapi2.bangbang93.com/maven' },
  { regex: /meta\.quiltmc\.org/g, replacement: 'bmclapi2.bangbang93.com/quilt-meta' }
];

const UPSTREAM = 'https://meta.prismlauncher.org/v1';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*'
};

/** 逐条应用域名替换。用函数形式替换，避免 replacement 中的 $ 被特殊处理。 */
function applyReplacements(body) {
  let result = body;
  for (const { regex, replacement } of REPLACEMENTS) {
    result = result.replace(regex, () => replacement);
  }
  return result;
}

/**
 * 删除索引文件里 versions / packages 条目的 sha1、sha256。
 * 因为替换 URL 后这些元数据 JSON 的哈希已经改变，
 * 保留原哈希会导致 Prism 校验失败。
 */
function stripIndexHashes(body) {
  try {
    const json = JSON.parse(body);
    let modified = false;

    if (Array.isArray(json.versions)) {
      for (const v of json.versions) {
        if ('sha256' in v) { delete v.sha256; modified = true; }
        if ('sha1' in v)   { delete v.sha1;   modified = true; }
      }
    }

    if (Array.isArray(json.packages)) {
      for (const p of json.packages) {
        if ('sha256' in p) { delete p.sha256; modified = true; }
        if ('sha1' in p)   { delete p.sha1;   modified = true; }
      }
    }

    return modified ? JSON.stringify(json) : body;
  } catch {
    return body;
  }
}

/** 删除因修改 body 而失效的响应头。 */
function cleanHeaders(headers) {
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('etag');
  headers.delete('last-modified');
  headers.delete('content-md5');
  headers.delete('transfer-encoding');
}

/** 给所有响应统一加上 CORS 头。 */
function withCors(headers) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  return headers;
}

export default {
  async fetch(request) {
    // 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 只允许 GET / HEAD
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: withCors(new Headers({ 'Content-Type': 'text/plain; charset=utf-8' }))
      });
    }

    const url = new URL(request.url);

    // 简单防护：拒绝异常路径
    if (url.pathname.includes('..') || url.pathname.length > 256) {
      return new Response('Bad Request', {
        status: 400,
        headers: withCors(new Headers({ 'Content-Type': 'text/plain; charset=utf-8' }))
      });
    }

    // 拼接上游 URL。UPSTREAM 末尾没有斜杠，
    // url.pathname 以斜杠开头，因此不会产生双斜杠。
    const upstreamUrl = new URL(UPSTREAM + url.pathname);
    upstreamUrl.search = url.search;

    let response;
    try {
      response = await fetch(upstreamUrl.toString(), {
        method: request.method,
        cf: { cacheTtl: 86400, cacheEverything: true }
      });
    } catch (err) {
      return new Response('Upstream fetch failed: ' + (err && err.message ? err.message : err), {
        status: 502,
        headers: withCors(new Headers({ 'Content-Type': 'text/plain; charset=utf-8' }))
      });
    }

    const headers = new Headers(response.headers);
    withCors(headers);
    cleanHeaders(headers);

    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('json');
    const isText = isJson || contentType.includes('text');

    // 非文本响应，或非成功响应：直接透传
    if (!response.ok || !isText) {
      return new Response(request.method === 'HEAD' ? null : response.body, {
        status: response.status,
        headers
      });
    }

    if (request.method === 'HEAD') {
      headers.set('Content-Type', contentType || 'application/json; charset=utf-8');
      return new Response(null, { status: response.status, headers });
    }

    let body = await response.text();
    body = applyReplacements(body);
    body = stripIndexHashes(body);

    headers.set('Content-Type', isJson ? 'application/json; charset=utf-8' : contentType);
    if (!headers.has('cache-control')) {
      headers.set('Cache-Control', 'public, max-age=3600');
    }

    return new Response(body, { status: response.status, headers });
  }
};
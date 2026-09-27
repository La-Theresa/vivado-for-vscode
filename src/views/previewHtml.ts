const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

export function previewHtml(script: string, style: string, cspSource: string, nonce: string): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${escape(nonce)}'; style-src ${escape(cspSource)}; font-src ${escape(cspSource)}; img-src ${escape(cspSource)} data:;">
<link rel="stylesheet" href="${escape(style)}">
<title>Vivado Preview</title></head><body>
<div id="app"><p class="message" role="status">Loading preview...</p></div>
<script nonce="${escape(nonce)}" src="${escape(script)}"></script>
</body></html>`;
}

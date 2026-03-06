// S3 Lite - with Cognito auth + SigV4 API signing
(function () {
  'use strict';

  var CONFIG = window.S3B_CONFIG || {};
  var currentBucket = null;
  var currentBucketRegion = null;
  var currentPrefix = '';
  var continuationToken = null;
  var selectedObjects = new Set();
  var allObjects = [];
  var credentialsReady = false;

  var $1 = function(sel) { return document.querySelector(sel); };
  var $$ = function(sel) { return document.querySelectorAll(sel); };

  // --- Auth: get ID token from cookie ---
  function getIdToken() {
    var cookies = document.cookie.split(';');
    for (var i = 0; i < cookies.length; i++) {
      var c = cookies[i].trim();
      if (c.startsWith('s3b_id_token=')) {
        return c.substring('s3b_id_token='.length);
      }
    }
    return null;
  }

  function getEmailFromToken(token) {
    if (!token) return null;
    try {
      var payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload.email || payload['cognito:username'] || null;
    } catch (e) { return null; }
  }

  function logout() {
    document.cookie = 's3b_id_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; secure; samesite=lax';
    try { localStorage.removeItem('s3b_refresh_token'); } catch(e) {}
    window.location.href = '/login.html';
  }

  // --- Init AWS credentials ---
  function initCredentials() {
    var idToken = getIdToken();
    if (!idToken) { logout(); return Promise.reject('No token'); }

    var logins = {};
    logins['cognito-idp.' + CONFIG.region + '.amazonaws.com/' + CONFIG.userPoolId] = idToken;

    AWS.config.region = CONFIG.region;
    AWS.config.credentials = new AWS.CognitoIdentityCredentials({
      IdentityPoolId: CONFIG.identityPoolId,
      Logins: logins
    });

    return new Promise(function(resolve, reject) {
      AWS.config.credentials.get(function(err) {
        if (err) {
          console.error('Credential error:', err);
          reject(err);
        } else {
          credentialsReady = true;
          resolve();
        }
      });
    });
  }

  function ensureCredentials() {
    if (credentialsReady && AWS.config.credentials && !AWS.config.credentials.needsRefresh()) {
      return Promise.resolve();
    }
    return initCredentials();
  }

  // --- API with SigV4 signing ---
  async function api(path, opts) {
    opts = opts || {};
    await ensureCredentials();

    // Use the direct API Gateway endpoint for SigV4 signing
    var apiHost = CONFIG.apiEndpoint.replace('https://', '').replace(/\/prod\/?$/, '');
    var apiPath = '/prod/api/' + path;
    var url = new URL('https://' + apiHost + apiPath);
    if (opts.params) {
      Object.keys(opts.params).forEach(function(k) {
        var v = opts.params[k];
        if (v != null && v !== '') url.searchParams.set(k, v);
      });
    }

    var method = opts.method || 'GET';
    var body = opts.body ? JSON.stringify(opts.body) : undefined;

    // Sign the request against the real API Gateway host
    var request = new AWS.HttpRequest(url.toString(), CONFIG.region);
    request.method = method;
    request.headers['Host'] = apiHost;
    request.headers['Content-Type'] = 'application/json';
    if (body) request.body = body;

    var signer = new AWS.Signers.V4(request, 'execute-api');
    signer.addAuthorization(AWS.config.credentials, new Date());

    // Build the CloudFront URL (same origin, no CORS issues)
    var cfUrl = new URL('/api/' + path, window.location.origin);
    url.searchParams.forEach(function(v, k) { cfUrl.searchParams.set(k, v); });

    var fetchOpts = {
      method: method,
      headers: {}
    };

    // Copy signed headers — these will be forwarded by CloudFront to API Gateway
    Object.keys(request.headers).forEach(function(k) {
      var lower = k.toLowerCase();
      if (lower !== 'content-length') {
        fetchOpts.headers[k] = request.headers[k];
      }
    });

    if (body) fetchOpts.body = body;

    var res = await fetch(cfUrl.toString(), fetchOpts);

    if (res.status === 403 || res.status === 401) {
      // Credentials may have expired, try refreshing once
      credentialsReady = false;
      try {
        await initCredentials();
        // Retry the request
        var retryRequest = new AWS.HttpRequest('https://' + apiHost + apiPath + url.search, CONFIG.region);
        retryRequest.method = method;
        retryRequest.headers['Host'] = apiHost;
        retryRequest.headers['Content-Type'] = 'application/json';
        if (body) retryRequest.body = body;
        var retrySigner = new AWS.Signers.V4(retryRequest, 'execute-api');
        retrySigner.addAuthorization(AWS.config.credentials, new Date());
        var retryOpts = { method: method, headers: {} };
        Object.keys(retryRequest.headers).forEach(function(k) {
          var lower = k.toLowerCase();
          if (lower !== 'content-length') retryOpts.headers[k] = retryRequest.headers[k];
        });
        if (body) retryOpts.body = body;
        res = await fetch(cfUrl.toString(), retryOpts);
        if (res.status === 403 || res.status === 401) { logout(); return; }
      } catch (e) { logout(); return; }
    }

    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'API error ' + res.status);
    return data;
  }

  // --- Utilities ---
  function fmtBytes(b) {
    if (!b) return '0 B';
    var k = 1024, s = ['B','KB','MB','GB','TB','PB'];
    var i = Math.floor(Math.log(b) / Math.log(k));
    return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + s[i];
  }
  function fmtNum(n) { return (n || 0).toLocaleString(); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function escJs(s) { return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
  function showLoading(t) { $1('#loading-text').textContent = t || 'Loading...'; $1('#loading-overlay').classList.add('active'); }
  function hideLoading() { $1('#loading-overlay').classList.remove('active'); }

  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = msg;
    $1('#toast-container').appendChild(el);
    setTimeout(function() { el.remove(); }, 4000);
  }

  // --- S3 Console Links ---
  function s3ConsoleUrl(bucket, key, region) {
    region = region || CONFIG.region;
    if (!key) return 'https://s3.console.aws.amazon.com/s3/buckets/' + encodeURIComponent(bucket) + '?region=' + region;
    if (key.endsWith('/')) return 'https://s3.console.aws.amazon.com/s3/buckets/' + encodeURIComponent(bucket) + '?prefix=' + encodeURIComponent(key) + '&region=' + region;
    return 'https://s3.console.aws.amazon.com/s3/object/' + encodeURIComponent(bucket) + '?prefix=' + encodeURIComponent(key) + '&region=' + region;
  }

  function s3ConsoleDeleteUrl(bucket, region) {
    region = region || CONFIG.region;
    return 'https://' + region + '.console.aws.amazon.com/s3/bucket/' + encodeURIComponent(bucket) + '/delete?region=' + region;
  }

  var consoleSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

  function showConfirm(title, message, onConfirm, recommendation) {
    $1('#confirm-title').textContent = title;
    $1('#confirm-message').textContent = message;
    var recEl = $1('#confirm-recommendation');
    if (recommendation) {
      recEl.innerHTML = recommendation;
      recEl.style.display = 'block';
    } else {
      recEl.style.display = 'none';
    }
    $1('#confirm-dialog').classList.add('active');
    $1('#confirm-cancel').onclick = function() { $1('#confirm-dialog').classList.remove('active'); };
    $1('#confirm-ok').onclick = function() { $1('#confirm-dialog').classList.remove('active'); onConfirm(); };
  }

  function showTypedConfirm(title, message, phrase, onConfirm) {
    $1('#typed-confirm-title').textContent = title;
    $1('#typed-confirm-message').textContent = message;
    $1('#typed-confirm-hint').textContent = 'Type "' + phrase + '" to confirm:';
    var input = $1('#typed-confirm-input');
    var okBtn = $1('#typed-confirm-ok');
    input.value = '';
    okBtn.disabled = true;
    input.oninput = function() {
      okBtn.disabled = input.value.trim() !== phrase;
    };
    $1('#typed-confirm-dialog').classList.add('active');
    input.focus();
    $1('#typed-confirm-cancel').onclick = function() {
      $1('#typed-confirm-dialog').classList.remove('active');
    };
    okBtn.onclick = function() {
      if (input.value.trim() === phrase) {
        $1('#typed-confirm-dialog').classList.remove('active');
        onConfirm();
      }
    };
  }

  var SIZE_500MB = 500 * 1024 * 1024;
  var SIZE_5GB = 5 * 1024 * 1024 * 1024;

  function transferRecommendation(size, type, path) {
    if (!size || size < SIZE_500MB) return null;
    if (size >= SIZE_5GB) {
      return '<strong>Large transfer (' + fmtBytes(size) + ')</strong> — Browser transfers of this size are unreliable. ' +
        'For best results, use <a href="https://aws.amazon.com/datasync/getting-started/" target="_blank" rel="noopener">AWS DataSync</a> ' +
        'for fast, automated transfers with retry and verification built in.';
    }
    var cmd = type === 'download'
      ? 'aws s3 cp s3://' + currentBucket + '/' + path + ' ./' + path.split('/').pop()
      : 'aws s3 cp ./' + path.split('/').pop() + ' s3://' + currentBucket + '/' + path;
    return '<strong>Tip:</strong> For files this size (' + fmtBytes(size) + '), the AWS CLI is faster and more reliable:' +
      '<code onclick="navigator.clipboard.writeText(this.textContent).then(function(){});" title="Click to copy">' + esc(cmd) + '</code>';
  }

  function bulkTransferRecommendation(size, count) {
    if (!size || size < SIZE_500MB) return null;
    if (size >= SIZE_5GB) {
      return '<strong>Large transfer (' + fmtBytes(size) + ', ' + count + ' files)</strong> — Browser downloads of this size may fail or be very slow. ' +
        'For best results, use <a href="https://aws.amazon.com/datasync/getting-started/" target="_blank" rel="noopener">AWS DataSync</a> ' +
        'for fast, automated transfers with retry and verification built in.';
    }
    var prefix = currentPrefix || '';
    var cmd = 'aws s3 sync s3://' + currentBucket + '/' + prefix + ' ./' + (currentBucket + (prefix ? '/' + prefix : ''));
    return '<strong>Tip:</strong> For bulk downloads this size (' + fmtBytes(size) + '), the AWS CLI is faster and more reliable:' +
      '<code onclick="navigator.clipboard.writeText(this.textContent).then(function(){});" title="Click to copy">' + esc(cmd) + '</code>';
  }

  // --- Navigation ---
  function updateHash(view, params) {
    params = params || {};
    var hash = '#/';
    if (view === 'bucket') {
      hash = '#/bucket/' + encodeURIComponent(params.bucket);
      if (params.prefix) hash += '/prefix/' + params.prefix.split('/').map(encodeURIComponent).join('/');
    } else if (view === 'object') {
      hash = '#/object/' + encodeURIComponent(params.bucket || currentBucket) + '/' + params.key.split('/').map(encodeURIComponent).join('/');
    }
    if (window.location.hash !== hash) {
      history.pushState(null, '', hash);
    }
  }

  function parseHash() {
    var hash = window.location.hash || '#/';
    if (hash.startsWith('#/bucket/')) {
      var rest = hash.substring('#/bucket/'.length);
      var prefixIdx = rest.indexOf('/prefix/');
      if (prefixIdx !== -1) {
        var bucket = decodeURIComponent(rest.substring(0, prefixIdx));
        var prefix = rest.substring(prefixIdx + '/prefix/'.length).split('/').map(decodeURIComponent).join('/');
        return { view: 'bucket', params: { bucket: bucket, prefix: prefix } };
      }
      return { view: 'bucket', params: { bucket: decodeURIComponent(rest) } };
    }
    if (hash.startsWith('#/object/')) {
      var parts = hash.substring('#/object/'.length).split('/');
      var bucket = decodeURIComponent(parts[0]);
      var key = parts.slice(1).map(decodeURIComponent).join('/');
      return { view: 'object', params: { bucket: bucket, key: key } };
    }
    return { view: 'home', params: {} };
  }

  window.navigateTo = function(view, params) {
    $$('.view').forEach(function(v) { v.style.display = 'none'; });
    selectedObjects.clear();
    updateSelectedCount();
    params = params || {};
    updateHash(view, params);

    if (view === 'home') {
      currentBucket = null;
      currentBucketRegion = null;
      currentPrefix = '';
      $1('#home-view').style.display = 'block';
      updateBreadcrumb([{ label: 'Home' }]);
      loadMetrics();
      loadAutoTieringStatus();
      loadBucketList();
    } else if (view === 'bucket') {
      currentBucket = params.bucket;
      currentBucketRegion = params.region || currentBucketRegion;
      currentPrefix = params.prefix || '';
      $1('#bucket-view').style.display = 'block';
      updateBreadcrumb(buildBucketBreadcrumb());
      // Fetch region if not known, then update console links
      if (!currentBucketRegion) {
        api('buckets/' + currentBucket + '/location').then(function(data) {
          currentBucketRegion = data.Region || CONFIG.region;
          $1('#bucket-console-link').href = s3ConsoleUrl(currentBucket, currentPrefix || null, currentBucketRegion);
          $1('#btn-delete-bucket').href = s3ConsoleDeleteUrl(currentBucket, currentBucketRegion);
        }).catch(function() { currentBucketRegion = CONFIG.region; });
      } else {
        $1('#bucket-console-link').href = s3ConsoleUrl(currentBucket, currentPrefix || null, currentBucketRegion);
        $1('#btn-delete-bucket').href = s3ConsoleDeleteUrl(currentBucket, currentBucketRegion);
      }
      loadBucketContents();
    } else if (view === 'object') {
      currentBucket = params.bucket || currentBucket;
      $1('#object-view').style.display = 'block';
      updateBreadcrumb(buildObjectBreadcrumb(params.key));
      loadObjectDetail(currentBucket, params.key);
    }
  };

  window.viewObject = function(key) {
    window.navigateTo('object', { bucket: currentBucket, key: key });
  };

  function updateBreadcrumb(items) {
    $1('#breadcrumb').innerHTML = items.map(function(item, i) {
      if (i === items.length - 1) return '<span>' + esc(item.label) + '</span>';
      return '<a onclick="' + (item.onclick || '') + '">' + esc(item.label) + '</a><span class="sep">/</span>';
    }).join('');
  }

  function buildBucketBreadcrumb() {
    var crumbs = [{ label: 'Home', onclick: "navigateTo('home')" }];
    if (!currentPrefix) {
      crumbs.push({ label: currentBucket });
    } else {
      crumbs.push({ label: currentBucket, onclick: "navigateTo('bucket', {bucket:'" + escJs(currentBucket) + "'})" });
      var parts = currentPrefix.replace(/\/$/, '').split('/');
      parts.forEach(function(part, i) {
        var prefix = parts.slice(0, i + 1).join('/') + '/';
        if (i === parts.length - 1) crumbs.push({ label: part });
        else crumbs.push({ label: part, onclick: "navigateTo('bucket', {bucket:'" + escJs(currentBucket) + "', prefix:'" + escJs(prefix) + "'})" });
      });
    }
    return crumbs;
  }

  function buildObjectBreadcrumb(key) {
    var crumbs = [{ label: 'Home', onclick: "navigateTo('home')" }];
    var parts = key.split('/');
    var fileName = parts.pop();
    crumbs.push({ label: currentBucket, onclick: "navigateTo('bucket', {bucket:'" + escJs(currentBucket) + "'})" });
    var prefix = '';
    parts.forEach(function(part) {
      prefix += part + '/';
      crumbs.push({ label: part, onclick: "navigateTo('bucket', {bucket:'" + escJs(currentBucket) + "', prefix:'" + escJs(prefix) + "'})" });
    });
    crumbs.push({ label: fileName });
    return crumbs;
  }

  // --- Home: Metrics ---
  async function loadAccountInfo() {
    try {
      var data = await api('account-info');
      var display = data.accountName ? data.accountName + ' (' + data.accountId + ')' : data.accountId;
      $1('#aws-account-id').textContent = display;
    } catch (err) {
      $1('#aws-account-id').textContent = '-';
    }
  }

  async function loadMetrics() {
    $1('#total-buckets').textContent = '...';
    $1('#total-objects').textContent = '...';
    $1('#total-size').textContent = '...';
    try {
      var data = await api('metrics');
      $1('#total-buckets').textContent = fmtNum(data.totalBuckets);
      $1('#total-objects').textContent = fmtNum(data.totalObjects);
      $1('#total-size').textContent = fmtBytes(data.totalSize);
    } catch (err) {
      toast('Failed to load metrics: ' + err.message, 'error');
      $1('#total-buckets').textContent = '-';
      $1('#total-objects').textContent = '-';
      $1('#total-size').textContent = '-';
    }
  }

  // --- Home: Auto-Tiering Status ---
  async function loadAutoTieringStatus() {
    var card = $1('#auto-tiering-card');
    var status = $1('#auto-tiering-status');
    try {
      var data = await api('lifecycle-status');
      card.style.display = '';
      if (data.enabled === data.total && data.total > 0) {
        status.innerHTML = '<span class="at-enabled">✓ All ' + data.total + ' buckets enabled</span>';
      } else if (data.enabled === 0) {
        status.innerHTML = '<span class="at-disabled">No buckets enabled</span>';
      } else {
        status.innerHTML = '<span class="at-enabled">' + data.enabled + ' enabled</span> · <span class="at-disabled">' + data.disabled + ' not enabled</span>';
      }
    } catch (err) { card.style.display = 'none'; }
  }

  $1('#btn-enable-all-tiering').addEventListener('click', function() {
    showConfirm('Enable Auto Intelligent-Tiering',
      'This will add a lifecycle rule to all buckets that transitions new S3 Standard objects to Intelligent-Tiering. Existing lifecycle rules are preserved.',
      async function() {
        showLoading('Enabling auto-tiering on all buckets...');
        try {
          var data = await api('lifecycle-enable', { method: 'POST', body: { buckets: 'all' } });
          if (data.async) { toast(data.message, 'info'); }
          else {
            var msg = data.applied + ' bucket' + (data.applied !== 1 ? 's' : '') + ' enabled';
            if (data.skipped) msg += ' (' + data.skipped + ' already had it)';
            if (data.errors) msg += ' (' + data.errors + ' errors)';
            toast(msg, 'success');
          }
          loadAutoTieringStatus();
        } catch (err) { toast('Failed: ' + err.message, 'error'); }
        finally { hideLoading(); }
      }
    );
  });

  $1('#btn-disable-all-tiering').addEventListener('click', function() {
    showConfirm('Disable Auto Intelligent-Tiering',
      'This will remove the auto-tiering lifecycle rule from all buckets. Other lifecycle rules are preserved. Objects already in Intelligent-Tiering stay there.',
      async function() {
        showLoading('Disabling auto-tiering...');
        try {
          var data = await api('lifecycle-disable', { method: 'POST', body: { buckets: 'all' } });
          if (data.async) { toast(data.message, 'info'); }
          else { toast(data.removed + ' bucket' + (data.removed !== 1 ? 's' : '') + ' updated', 'success'); }
          loadAutoTieringStatus();
        } catch (err) { toast('Failed: ' + err.message, 'error'); }
        finally { hideLoading(); }
      }
    );
  });

  // --- Home: Bucket List ---
  var allBuckets = [];
  var bucketSizes = {};
  var bucketPage = 0;
  var BUCKETS_PER_PAGE = 20;
  var bucketSortField = 'name';
  var bucketSortAsc = true;

  async function loadBucketList() {
    try {
      var data = await api('buckets');
      allBuckets = (data.Buckets || []);
      bucketSortField = 'name';
      bucketSortAsc = true;
      sortBuckets();
      bucketPage = 0;
      renderBucketList();
      loadBucketSizes();
    } catch (err) {
      toast('Failed to load buckets: ' + err.message, 'error');
    }
  }

  async function loadBucketSizes() {
    try {
      var data = await api('bucket-sizes');
      bucketSizes = data.sizes || {};
      renderBucketList();
    } catch (err) { /* silent */ }
  }

  function sortBuckets() {
    allBuckets.sort(function(a, b) {
      if (bucketSortField === 'name') {
        return bucketSortAsc ? a.Name.localeCompare(b.Name) : b.Name.localeCompare(a.Name);
      } else if (bucketSortField === 'size') {
        var sa = bucketSizes[a.Name] || 0, sb = bucketSizes[b.Name] || 0;
        return bucketSortAsc ? sa - sb : sb - sa;
      } else if (bucketSortField === 'date') {
        return bucketSortAsc ? a.CreationDate.localeCompare(b.CreationDate) : b.CreationDate.localeCompare(a.CreationDate);
      }
      return 0;
    });
  }

  function updateBucketSortArrows() {
    ['name', 'size', 'date'].forEach(function(f) {
      var el = $1('#bsort-' + f + ' .sort-arrow');
      if (el) el.textContent = bucketSortField === f ? (bucketSortAsc ? '▲' : '▼') : '';
    });
  }

  function onBucketSort(field) {
    if (bucketSortField === field) bucketSortAsc = !bucketSortAsc;
    else { bucketSortField = field; bucketSortAsc = field === 'name'; }
    sortBuckets();
    bucketPage = 0;
    renderBucketList();
  }

  $1('#bsort-name').addEventListener('click', function() { onBucketSort('name'); });
  $1('#bsort-size').addEventListener('click', function() { onBucketSort('size'); });
  $1('#bsort-date').addEventListener('click', function() { onBucketSort('date'); });

  function renderBucketList() {
    var start = bucketPage * BUCKETS_PER_PAGE;
    var page = allBuckets.slice(start, start + BUCKETS_PER_PAGE);
    var totalPages = Math.ceil(allBuckets.length / BUCKETS_PER_PAGE);

    updateBucketSortArrows();
    $1('#bucket-list-count').textContent = allBuckets.length + ' buckets';
    $1('#bucket-list-body').innerHTML = page.map(function(b) {
      var size = bucketSizes[b.Name];
      var sizeStr = size != null ? fmtBytes(size) : '...';
      return '<tr class="bucket-row" onclick="navigateTo(\'bucket\', {bucket:\'' + escJs(b.Name) + '\', region:\'' + escJs(b.Region || '') + '\'})">' +
        '<td><span class="object-name-cell">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> ' +
        esc(b.Name) + '<span class="region-badge">' + esc(b.Region || '') + '</span>' +
        '<a href="' + s3ConsoleUrl(b.Name, null, b.Region) + '" target="_blank" rel="noopener" class="console-link" title="Open in S3 Console" onclick="event.stopPropagation();">' + consoleSvg + '</a></span></td>' +
        '<td>' + sizeStr + '</td>' +
        '<td>' + new Date(b.CreationDate).toLocaleDateString() + '</td></tr>';
    }).join('');

    var pag = $1('#bucket-pagination');
    if (totalPages <= 1) { pag.innerHTML = ''; return; }
    var html = '<button class="btn btn-sm btn-secondary" id="bp-prev"' + (bucketPage === 0 ? ' disabled' : '') + '>&laquo; Prev</button>';
    html += '<span class="pagination-info">Page ' + (bucketPage + 1) + ' of ' + totalPages + '</span>';
    html += '<button class="btn btn-sm btn-secondary" id="bp-next"' + (bucketPage >= totalPages - 1 ? ' disabled' : '') + '>Next &raquo;</button>';
    pag.innerHTML = html;
    $1('#bp-prev').onclick = function() { if (bucketPage > 0) { bucketPage--; renderBucketList(); } };
    $1('#bp-next').onclick = function() { if (bucketPage < totalPages - 1) { bucketPage++; renderBucketList(); } };
  }

  // --- Home: Bucket Search ---
  var searchTimeout;
  var searchInput = $1('#bucket-search');
  var searchResults = $1('#search-results');

  searchInput.addEventListener('input', function() {
    var q = searchInput.value.trim();
    clearTimeout(searchTimeout);
    if (q.length < 3) {
      searchResults.classList.remove('active');
      searchResults.innerHTML = '';
      return;
    }
    searchTimeout = setTimeout(function() { searchBuckets(q); }, 300);
  });

  document.addEventListener('click', function(e) {
    if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
      searchResults.classList.remove('active');
    }
  });

  async function searchBuckets(q) {
    try {
      var data = await api('buckets/search', { params: { q: q } });
      var buckets = data.Buckets || [];
      if (buckets.length === 0) {
        searchResults.innerHTML = '<div class="search-hint">No buckets matching "' + esc(q) + '"</div>';
      } else {
        searchResults.innerHTML = buckets.map(function(b) {
          var size = bucketSizes[b.Name];
          var sizeStr = size != null ? fmtBytes(size) : '';
          return '<div class="search-result-item" onclick="navigateTo(\'bucket\', {bucket:\'' + escJs(b.Name) + '\', region:\'' + escJs(b.Region || '') + '\'})">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0ea5e9" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' +
            '<span class="search-result-name">' + esc(b.Name) + '</span>' +
            (b.Region ? '<span class="region-badge">' + esc(b.Region) + '</span>' : '') +
            (sizeStr ? '<span class="search-result-size">' + sizeStr + '</span>' : '') +
            '<span class="search-result-date">' + new Date(b.CreationDate).toLocaleDateString() + '</span></div>';
        }).join('');
      }
      searchResults.classList.add('active');
    } catch (err) {
      searchResults.innerHTML = '<div class="search-hint">Search failed: ' + esc(err.message) + '</div>';
      searchResults.classList.add('active');
    }
  }

  // --- Bucket Contents (paginated) ---
  async function loadBucketContents() {
    showLoading('Loading objects...');
    allObjects = [];
    continuationToken = null;
    selectedObjects.clear();
    updateSelectedCount();
    objSortField = 'name';
    objSortAsc = true;
    try {
      await fetchObjects(false);
      renderObjectTable();
      updateBucketStats();
      loadBucketTotalStats();
      loadVersionInfo();
      loadBucketLifecycle();
    } catch (err) {
      toast('Failed to load bucket: ' + err.message, 'error');
    } finally {
      hideLoading();
    }
  }

  async function loadBucketTotalStats() {
    $1('#bucket-total-object-count').textContent = '...';
    $1('#bucket-total-bucket-size').textContent = '...';
    var banner = $1('#bucket-standard-tier-banner');
    banner.style.display = 'none';
    try {
      var data = await api('buckets/' + currentBucket + '/storage-breakdown', {
        params: { prefix: currentPrefix }
      });
      var approx = data.partial ? '~' : '';
      $1('#bucket-total-object-count').textContent = approx + fmtNum(data.totalCount);
      $1('#bucket-total-bucket-size').textContent = approx + fmtBytes(data.totalSize);
      if (data.standardCount > 0) {
        $1('#std-bucket-count').textContent = approx + fmtNum(data.standardCount);
        $1('#std-bucket-size').textContent = approx + fmtBytes(data.standardSize);
        banner.style.display = 'flex';
      }
    } catch (err) {
      $1('#bucket-total-object-count').textContent = '-';
      $1('#bucket-total-bucket-size').textContent = '-';
    }
  }

  async function loadVersionInfo() {
    var banner = $1('#bucket-version-banner');
    banner.style.display = 'none';
    try {
      var data = await api('buckets/' + currentBucket + '/version-info', {
        params: { prefix: currentPrefix }
      });
      if (!data.versioned) return;
      var dm = data.deleteMarkers || 0;
      var nc = data.nonCurrentVersions || 0;
      var ncSize = data.nonCurrentSize || 0;
      if (dm === 0 && nc === 0) return;
      var approx = data.partial ? '~' : '';
      var parts = [];
      if (dm > 0) parts.push('<strong>' + approx + fmtNum(dm) + '</strong> delete marker' + (dm !== 1 ? 's' : ''));
      if (nc > 0) parts.push('<strong>' + approx + fmtNum(nc) + '</strong> non-current version' + (nc !== 1 ? 's' : '') + ' (' + fmtBytes(ncSize) + ')');
      $1('#version-banner-text').innerHTML = 'This bucket has ' + parts.join(' and ') + ' consuming storage.' + (data.partial ? ' (scan incomplete, may be more)' : '');
      $1('#btn-cleanup-markers').style.display = dm > 0 ? '' : 'none';
      $1('#btn-cleanup-versions').style.display = nc > 0 ? '' : 'none';
      banner.style.display = 'flex';
    } catch (err) { /* silent */ }
  }

  function doCleanupVersions(mode) {
    var label = mode === 'all' ? 'delete markers and old versions' : mode === 'markers' ? 'delete markers' : 'old versions';
    showTypedConfirm('Clean Up Versions',
      'This will permanently remove ' + label + ' from "' + currentBucket + '". This cannot be undone.',
      'CLEAN UP',
      async function() {
        showLoading('Cleaning up ' + label + '...');
        try {
          var data = await api('buckets/' + currentBucket + '/cleanup-versions', {
            method: 'POST',
            body: { prefix: currentPrefix, mode: mode }
          });
          if (data.async) {
            toast(data.message, 'info');
          } else {
            var msgs = [];
            if (data.deleteMarkers) msgs.push(data.deleteMarkers + ' delete markers');
            if (data.versions) msgs.push(data.versions + ' old versions');
            toast('Removed ' + (msgs.join(' and ') || 'nothing to clean') + (data.errors ? ' (' + data.errors + ' errors)' : ''), 'success');
          }
          $1('#bucket-version-banner').style.display = 'none';
          loadBucketContents();
        } catch (err) { toast('Cleanup failed: ' + err.message, 'error'); }
        finally { hideLoading(); }
      }
    );
  }

  $1('#btn-cleanup-all').addEventListener('click', function() { doCleanupVersions('all'); });
  $1('#btn-cleanup-markers').addEventListener('click', function() { doCleanupVersions('markers'); });
  $1('#btn-cleanup-versions').addEventListener('click', function() { doCleanupVersions('versions'); });

  $1('#btn-delete-empty-bucket').addEventListener('click', function(e) {
    e.preventDefault();
    window.open(s3ConsoleDeleteUrl(currentBucket, currentBucketRegion), '_blank');
  });

  // --- Bucket: Lifecycle Rules ---
  var LIFECYCLE_SC_LABELS = {
    'INTELLIGENT_TIERING':'Intelligent-Tiering','STANDARD_IA':'Standard-IA','ONEZONE_IA':'One Zone-IA',
    'GLACIER':'Glacier Flexible','GLACIER_IR':'Glacier Instant','DEEP_ARCHIVE':'Deep Archive'
  };
  var MIN_DAYS = {'STANDARD_IA':30,'ONEZONE_IA':30,'GLACIER':0,'GLACIER_IR':90,'DEEP_ARCHIVE':0,'INTELLIGENT_TIERING':0};
  var currentLifecycleRules = [];

  async function loadBucketLifecycle() {
    var card = $1('#bucket-lifecycle-card');
    var list = $1('#lifecycle-rules-list');
    card.style.display = 'none';
    currentLifecycleRules = [];
    try {
      var data = await api('buckets/' + currentBucket + '/lifecycle');
      card.style.display = '';
      var rules = data.rules || [];
      currentLifecycleRules = rules;
      if (rules.length === 0) {
        list.innerHTML = '<div class="lifecycle-empty">No transition rules configured. <a href="https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-transition-general-considerations.html" target="_blank" rel="noopener" class="lifecycle-docs-link">Learn about lifecycle transitions →</a></div>';
      } else {
        list.innerHTML = rules.map(function(r) {
          var label = LIFECYCLE_SC_LABELS[r.storageClass] || r.storageClass;
          var detail = r.days === 0 ? 'Immediately' : 'After ' + r.days + ' days';
          if (r.prefix) detail += ' (prefix: ' + esc(r.prefix) + ')';
          return '<div class="lifecycle-rule-row">' +
            '<span class="lifecycle-rule-target">' + esc(label) + '</span>' +
            '<span class="lifecycle-rule-detail">' + detail + '</span>' +
            '<button class="lifecycle-rule-remove" onclick="removeBucketLifecycle(\'' + escJs(r.id) + '\')" title="Remove rule">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>';
        }).join('') +
        '<div class="lifecycle-docs"><a href="https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-transition-general-considerations.html" target="_blank" rel="noopener" class="lifecycle-docs-link">Lifecycle transition considerations →</a></div>';
      }
    } catch (err) { card.style.display = 'none'; }
  }

  $1('#btn-add-lifecycle').addEventListener('click', function() {
    $1('#lifecycle-add-form').style.display = 'flex';
    $1('#lifecycle-sc').value = 'INTELLIGENT_TIERING';
    $1('#lifecycle-days').value = '0';
    $1('#lifecycle-hint').textContent = '';
    updateLifecycleDaysHint();
  });
  $1('#btn-cancel-lifecycle').addEventListener('click', function() {
    $1('#lifecycle-add-form').style.display = 'none';
  });

  var LIFECYCLE_NOTES = {
    'DEEP_ARCHIVE': 'Objects in Deep Archive require a restore request before access (up to 12 hours). Minimum storage duration is 180 days. Objects smaller than 128 KB are charged as 128 KB — consider zipping small files before archiving.',
    'GLACIER': 'Objects in Glacier Flexible require a restore request before access (minutes to hours). Minimum storage duration is 90 days. Objects smaller than 128 KB are charged as 128 KB — consider zipping small files before archiving.',
    'GLACIER_IR': 'Glacier Instant Retrieval provides millisecond access but has a minimum storage duration of 90 days. Objects smaller than 128 KB are charged as 128 KB.',
    'STANDARD_IA': 'Standard-IA has a minimum storage duration of 30 days. Objects smaller than 128 KB are charged as 128 KB.',
    'ONEZONE_IA': 'One Zone-IA stores data in a single AZ (less resilient). Minimum storage duration is 30 days. Objects smaller than 128 KB are charged as 128 KB.'
  };
  var LIFECYCLE_TIMING_NOTE = 'Lifecycle rules are processed by S3 in batches — transitions may take 24–48 hours to apply, even with 0-day rules. For immediate transitions, use the storage class change on individual objects.';
  var CONFIRM_STORAGE_CLASSES = {'DEEP_ARCHIVE':true,'GLACIER':true};

  function updateLifecycleDaysHint() {
    var sc = $1('#lifecycle-sc').value;
    var days = parseInt($1('#lifecycle-days').value) || 0;
    var min = MIN_DAYS[sc] || 0;
    var daysInput = $1('#lifecycle-days');
    daysInput.min = min;
    if (parseInt(daysInput.value) < min) daysInput.value = min;
    days = parseInt(daysInput.value) || 0;
    var hints = [];
    if (min > 0) hints.push('Minimum ' + min + ' days required for ' + (LIFECYCLE_SC_LABELS[sc] || sc));
    var conflict = currentLifecycleRules.find(function(r) { return r.days === days && r.storageClass !== sc; });
    if (conflict) {
      hints.push('⚠ Conflict: an existing rule transitions to ' + (LIFECYCLE_SC_LABELS[conflict.storageClass] || conflict.storageClass) + ' at the same day. Remove it first to avoid errors.');
    }
    if (LIFECYCLE_NOTES[sc]) hints.push(LIFECYCLE_NOTES[sc]);
    hints.push(LIFECYCLE_TIMING_NOTE);
    $1('#lifecycle-hint').innerHTML = hints.join('<br>');
  }
  $1('#lifecycle-sc').addEventListener('change', updateLifecycleDaysHint);
  $1('#lifecycle-days').addEventListener('input', updateLifecycleDaysHint);

  $1('#btn-save-lifecycle').addEventListener('click', async function() {
    var sc = $1('#lifecycle-sc').value;
    var days = parseInt($1('#lifecycle-days').value) || 0;
    var min = MIN_DAYS[sc] || 0;
    if (days < min) { toast('Minimum ' + min + ' days for ' + (LIFECYCLE_SC_LABELS[sc] || sc), 'error'); return; }
    var conflict = currentLifecycleRules.find(function(r) { return r.days === days && r.storageClass !== sc; });
    if (conflict) {
      toast('Conflict with existing rule at day ' + days + ' → ' + (LIFECYCLE_SC_LABELS[conflict.storageClass] || conflict.storageClass) + '. Remove it first.', 'error');
      return;
    }
    function doSave() {
      showLoading('Adding lifecycle rule...');
      api('buckets/' + currentBucket + '/lifecycle', {
        method: 'POST',
        body: { storageClass: sc, days: days, prefix: currentPrefix }
      }).then(function() {
        toast('Lifecycle rule added: transition to ' + (LIFECYCLE_SC_LABELS[sc] || sc), 'success');
        $1('#lifecycle-add-form').style.display = 'none';
        loadBucketLifecycle();
      }).catch(function(err) { toast('Failed: ' + err.message, 'error'); })
      .finally(function() { hideLoading(); });
    }
    if (CONFIRM_STORAGE_CLASSES[sc]) {
      var label = LIFECYCLE_SC_LABELS[sc] || sc;
      showTypedConfirm('Confirm ' + label + ' Lifecycle Rule',
        'You are adding a lifecycle rule to transition objects to ' + label + '. ' +
        (LIFECYCLE_NOTES[sc] || '') + ' ' + LIFECYCLE_TIMING_NOTE,
        'AGREE', doSave);
    } else {
      doSave();
    }
  });

  window.removeBucketLifecycle = async function(ruleId) {
    showLoading('Removing rule...');
    try {
      await api('buckets/' + currentBucket + '/lifecycle', { method: 'DELETE', params: { ruleId: ruleId } });
      toast('Rule removed', 'success');
      loadBucketLifecycle();
    } catch (err) { toast('Failed: ' + err.message, 'error'); }
    finally { hideLoading(); }
  };

  async function fetchObjects(loadMore) {
    var res = await api('buckets/' + currentBucket + '/objects', {
      params: {
        prefix: currentPrefix,
        delimiter: '/',
        maxKeys: '50',
        continuationToken: loadMore ? continuationToken : null,
      }
    });
    var folders = (res.CommonPrefixes || []).map(function(p) {
      return { type: 'folder', key: p, name: p.replace(currentPrefix, '').replace(/\/$/, '') };
    });
    var files = (res.Contents || []).filter(function(o) { return o.Key !== currentPrefix; }).map(function(o) {
      return { type: 'file', key: o.Key, name: o.Key.replace(currentPrefix, ''),
        size: o.Size, storageClass: o.StorageClass || 'STANDARD', lastModified: o.LastModified };
    });
    if (!loadMore) allObjects = folders.concat(files);
    else allObjects = allObjects.concat(folders).concat(files);
    continuationToken = res.IsTruncated ? res.NextContinuationToken : null;
    $1('#btn-load-more').style.display = continuationToken ? 'inline-flex' : 'none';
  }

  var objSortField = 'name';
  var objSortAsc = true;

  function sortObjects() {
    var folders = allObjects.filter(function(o) { return o.type === 'folder'; });
    var files = allObjects.filter(function(o) { return o.type === 'file'; });
    folders.sort(function(a, b) {
      return objSortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
    });
    files.sort(function(a, b) {
      if (objSortField === 'name') return objSortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      if (objSortField === 'size') return objSortAsc ? (a.size || 0) - (b.size || 0) : (b.size || 0) - (a.size || 0);
      if (objSortField === 'date') return objSortAsc ? a.lastModified.localeCompare(b.lastModified) : b.lastModified.localeCompare(a.lastModified);
      return 0;
    });
    allObjects = folders.concat(files);
  }

  function updateObjSortArrows() {
    ['name', 'size', 'date'].forEach(function(f) {
      var el = $1('#osort-' + f + ' .sort-arrow');
      if (el) el.textContent = objSortField === f ? (objSortAsc ? '▲' : '▼') : '';
    });
  }

  function onObjSort(field) {
    if (objSortField === field) objSortAsc = !objSortAsc;
    else { objSortField = field; objSortAsc = field === 'name'; }
    sortObjects();
    renderObjectTable();
  }

  $1('#osort-name').addEventListener('click', function() { onObjSort('name'); });
  $1('#osort-size').addEventListener('click', function() { onObjSort('size'); });
  $1('#osort-date').addEventListener('click', function() { onObjSort('date'); });

  function renderObjectTable() {
    updateObjSortArrows();
    $1('#object-list').innerHTML = allObjects.map(function(obj) {
      if (obj.type === 'folder') {
        return '<tr data-name="' + esc(obj.name) + '"><td></td>' +
          '<td><span class="object-name-cell" onclick="navigateTo(\'bucket\', {bucket:\'' + escJs(currentBucket) + '\', prefix:\'' + escJs(obj.key) + '\'})">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> ' +
          esc(obj.name) + '/<a href="' + s3ConsoleUrl(currentBucket, obj.key, currentBucketRegion) + '" target="_blank" rel="noopener" class="console-link" title="Open in S3 Console" onclick="event.stopPropagation();">' + consoleSvg + '</a></span></td><td>-</td><td>-</td><td>-</td><td></td></tr>';
      }
      return '<tr data-name="' + esc(obj.name) + '" data-key="' + esc(obj.key) + '">' +
        '<td><input type="checkbox" class="obj-checkbox" data-key="' + esc(obj.key) + '"' + (selectedObjects.has(obj.key) ? ' checked' : '') + '></td>' +
        '<td><span class="object-name-cell" onclick="viewObject(\'' + escJs(obj.key) + '\')">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> ' +
        esc(obj.name) + '<a href="' + s3ConsoleUrl(currentBucket, obj.key, currentBucketRegion) + '" target="_blank" rel="noopener" class="console-link" title="Open in S3 Console" onclick="event.stopPropagation();">' + consoleSvg + '</a></span></td>' +
        '<td>' + fmtBytes(obj.size) + '</td>' +
        '<td><span class="badge">' + obj.storageClass + '</span></td>' +
        '<td>' + new Date(obj.lastModified).toLocaleString() + '</td>' +
        '<td><div class="action-cell">' +
        '<button class="btn btn-sm btn-icon" onclick="deleteObject(\'' + escJs(obj.key) + '\')" title="Open in S3 Console to delete"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>' +
        '<button class="btn btn-sm btn-secondary" onclick="handleDownloadFromList(\'' + escJs(obj.key) + '\',\'' + obj.storageClass + '\')">Download</button>' +
        '</div></td></tr>';
    }).join('');

    $$('.obj-checkbox').forEach(function(cb) {
      cb.addEventListener('change', function(e) {
        if (e.target.checked) selectedObjects.add(e.target.dataset.key);
        else selectedObjects.delete(e.target.dataset.key);
        updateSelectedCount();
      });
    });

    // Show info banner if bucket appears empty but metrics showed data
    var emptyBanner = $1('#bucket-empty-info-banner');
    var bucketHasMetrics = bucketSizes[currentBucket] && bucketSizes[currentBucket] > 0;
    if (allObjects.length === 0 && !currentPrefix && bucketHasMetrics) {
      emptyBanner.style.display = 'flex';
    } else {
      emptyBanner.style.display = 'none';
    }
  }

  function updateBucketStats() {
    var files = allObjects.filter(function(o) { return o.type === 'file'; });
    $1('#bucket-file-count').textContent = fmtNum(files.length);
    $1('#bucket-total-size').textContent = fmtBytes(files.reduce(function(s, o) { return s + (o.size || 0); }, 0));
  }

  $1('#btn-convert-bucket-it').addEventListener('click', function() {
    var count = $1('#std-bucket-count').textContent;
    var size = $1('#std-bucket-size').textContent;
    showConfirm('Switch to Intelligent-Tiering',
      'Convert ' + count + ' S3 Standard objects (' + size + ') in this bucket to Intelligent-Tiering?',
      async function() {
        showLoading('Converting objects to Intelligent-Tiering...');
        try {
          var data = await api('buckets/' + currentBucket + '/bulk-convert-it', {
            method: 'POST',
            body: { prefix: currentPrefix, archiveOptIn: false }
          });
          if (data.async) {
            toast(data.message, 'info');
            $1('#bucket-standard-tier-banner').style.display = 'none';
          } else {
            toast(data.converted + ' objects converted to Intelligent-Tiering' + (data.errors ? ' (' + data.errors + ' errors)' : ''), 'success');
            loadBucketContents();
          }
        } catch (err) { toast('Conversion failed: ' + err.message, 'error'); }
        finally { hideLoading(); }
      }
    );
  });

  function updateSelectedCount() {
    var btn = $1('#btn-download-selected');
    if (!btn) return;
    btn.disabled = selectedObjects.size === 0;
    btn.textContent = 'Download Selected (' + selectedObjects.size + ') as ZIP';
  }

  $1('#select-all').addEventListener('change', function(e) {
    $$('.obj-checkbox').forEach(function(cb) {
      cb.checked = e.target.checked;
      if (e.target.checked) selectedObjects.add(cb.dataset.key);
      else selectedObjects.delete(cb.dataset.key);
    });
    updateSelectedCount();
  });

  $1('#btn-load-more').addEventListener('click', async function() {
    showLoading('Loading more...');
    try { await fetchObjects(true); renderObjectTable(); updateBucketStats(); }
    catch (err) { toast('Failed: ' + err.message, 'error'); }
    finally { hideLoading(); }
  });

  // --- Object Detail ---
  async function loadObjectDetail(bucket, key) {
    showLoading('Loading object details...');
    try {
      var head = await api('buckets/' + bucket + '/object-detail', { params: { key: key } });
      $1('#object-name').innerHTML = esc(key.split('/').pop()) +
        ' <a href="' + s3ConsoleUrl(bucket, key, currentBucketRegion) + '" target="_blank" rel="noopener" class="console-link" title="Open in S3 Console">' + consoleSvg + '</a>';
      $1('#object-key').textContent = key;
      $1('#object-size').textContent = fmtBytes(head.ContentLength);
      $1('#object-storage-class').textContent = head.StorageClass || 'STANDARD';
      $1('#object-modified').textContent = new Date(head.LastModified).toLocaleString();
      $1('#object-etag').textContent = head.ETag || '-';
      $1('#new-tier').value = head.StorageClass || 'STANDARD';
      toggleArchiveOptin();

      var timeline = $1('#it-timeline');
      if (head.StorageClass === 'INTELLIGENT_TIERING') {
        timeline.style.display = 'block';
        renderITTimeline(head);
      } else {
        timeline.style.display = 'none';
      }

      $1('#btn-download-object').onclick = function() { handleDownload(key, head.StorageClass, head.ContentLength, head.ArchiveStatus); };
      $1('#btn-delete-object').onclick = function() { deleteObject(key); };
      $1('#btn-change-tier').onclick = function() { changeTier(bucket, key); };
    } catch (err) {
      toast('Failed to load object: ' + err.message, 'error');
    } finally {
      hideLoading();
    }
  }

  function renderITTimeline(head) {
    var lastMod = new Date(head.LastModified);
    var now = new Date();
    var daysSince = Math.floor((now - lastMod) / (1000 * 60 * 60 * 24));
    var steps = [
      { tier: 'Frequent Access', days: 0, desc: 'Immediate' },
      { tier: 'Infrequent Access', days: 30, desc: 'After 30 days without access' },
    ];
    var itConfig = head.ITConfig || [];
    itConfig.forEach(function(c) {
      if (c.AccessTier === 'ARCHIVE_ACCESS') steps.push({ tier: 'Archive Access', days: c.Days, desc: 'After ' + c.Days + ' days' });
      if (c.AccessTier === 'DEEP_ARCHIVE_ACCESS') steps.push({ tier: 'Deep Archive Access', days: c.Days, desc: 'After ' + c.Days + ' days' });
    });
    steps.sort(function(a, b) { return a.days - b.days; });

    var html = steps.map(function(step) {
      var transDate = new Date(lastMod.getTime() + step.days * 86400000);
      var isPast = daysSince >= step.days;
      var isCurrent = false;
      var nextStep = steps.find(function(s) { return s.days > step.days; });
      if (isPast && (!nextStep || daysSince < nextStep.days)) isCurrent = true;
      var dotClass = isCurrent ? 'active' : (isPast ? 'past' : 'upcoming');
      var dateStr = step.days === 0 ? 'Upload date' : transDate.toLocaleDateString();
      var status = isCurrent ? ' (current)' : (isPast ? ' (passed)' : '');
      return '<div class="it-step">' +
        '<div class="it-step-dot ' + dotClass + '"></div>' +
        '<span class="it-step-tier">' + step.tier + status + '</span>' +
        '<span class="it-step-date">' + step.desc + ' — ' + dateStr + '</span></div>';
    }).join('');

    if (itConfig.length === 0) {
      html += '<div style="margin-top:0.5rem;font-size:0.8125rem;color:#64748b;">Archive tiers not enabled on this bucket. Enable via the storage class change below.</div>';
    }
    $1('#it-timeline-content').innerHTML = html;
  }

  function toggleArchiveOptin() {
    var sel = $1('#new-tier').value;
    $1('#archive-optin-label').style.display = sel === 'INTELLIGENT_TIERING' ? 'inline-flex' : 'none';
    if (sel !== 'INTELLIGENT_TIERING') $1('#archive-optin').checked = false;
  }
  $1('#new-tier').addEventListener('change', toggleArchiveOptin);

  // --- Actions ---
  function handleDownload(key, storageClass, size, archiveStatus) {
    var sizeStr = size != null ? ' (' + fmtBytes(size) + ')' : '';
    var rec = transferRecommendation(size, 'download', key);
    var isArchivedIT = storageClass === 'INTELLIGENT_TIERING' && archiveStatus && archiveStatus !== '';
    if (isArchivedIT) {
      showConfirm('Download Warning',
        'This object' + sizeStr + ' is in Intelligent-Tiering (' + archiveStatus.replace(/_/g, ' ').toLowerCase() + '). Downloading it will move it back to the Frequent Access tier, which may increase storage costs. Continue?',
        function() { downloadObject(key); },
        rec
      );
    } else {
      showConfirm('Download File',
        'Download "' + key.split('/').pop() + '"' + sizeStr + '?',
        function() { downloadObject(key); },
        rec
      );
    }
  }

  window.handleDownloadFromList = function(key, storageClass) {
    var obj = allObjects.find(function(o) { return o.key === key; });
    var size = obj ? obj.size : null;
    handleDownload(key, storageClass, size);
  };

  window.downloadObject = async function(key) {
    showLoading('Getting download link...');
    try {
      var data = await api('buckets/' + currentBucket + '/download', { params: { key: key } });
      window.open(data.url, '_blank');
      toast('Download started', 'success');
    } catch (err) {
      toast('Download failed: ' + err.message, 'error');
    } finally {
      hideLoading();
    }
  };

  window.deleteObject = function(key) {
    var prefix = key.substring(0, key.lastIndexOf('/') + 1) || '';
    var url = s3ConsoleUrl(currentBucket, prefix || null, currentBucketRegion);
    window.open(url, '_blank');
  };

  async function changeTier(bucket, key) {
    var newClass = $1('#new-tier').value;
    var archiveOptIn = $1('#archive-optin').checked;
    showLoading('Changing storage class...');
    try {
      await api('buckets/' + bucket + '/change-tier', {
        method: 'POST',
        body: { key: key, storageClass: newClass, archiveOptIn: archiveOptIn }
      });
      var msg = 'Storage class changed to ' + newClass;
      if (archiveOptIn) msg += ' with Archive Access tiers enabled';
      toast(msg, 'success');
      loadObjectDetail(bucket, key);
    } catch (err) { toast('Failed: ' + err.message, 'error'); }
    finally { hideLoading(); }
  }

  // --- ZIP Downloads ---
  $1('#btn-download-selected').addEventListener('click', async function() {
    if (selectedObjects.size === 0) return;
    var keys = Array.from(selectedObjects);
    var totalSize = allObjects.filter(function(o) { return selectedObjects.has(o.key); })
      .reduce(function(s, o) { return s + (o.size || 0); }, 0);
    var phrase = keys.length === 1 ? 'file' : keys.length + ' files';
    var rec = bulkTransferRecommendation(totalSize, keys.length);
    showConfirm('Download ' + keys.length + ' File(s)',
      'Download ' + phrase + ' (' + fmtBytes(totalSize) + ') as ZIP?',
      async function() { await downloadAsZip(keys); },
      rec
    );
  });

  $1('#btn-download-bucket').addEventListener('click', function() {
    var keys = allObjects.filter(function(o) { return o.type === 'file'; });
    if (!keys.length) { toast('No files to download', 'info'); return; }
    var totalSize = keys.reduce(function(s, o) { return s + (o.size || 0); }, 0);
    var rec = bulkTransferRecommendation(totalSize, keys.length);
    showConfirm('Download All', 'Download all ' + keys.length + ' objects (' + fmtBytes(totalSize) + ') in this view as ZIP?', async function() {
      await downloadAsZip(keys.map(function(o) { return o.key; }));
    }, rec);
  });

  async function downloadAsZip(keys) {
    showLoading('Downloading ' + keys.length + ' files...');
    try {
      var zip = new JSZip();
      for (var i = 0; i < keys.length; i++) {
        $1('#loading-text').textContent = 'Downloading ' + (i + 1) + ' of ' + keys.length + '...';
        var data = await api('buckets/' + currentBucket + '/download', { params: { key: keys[i] } });
        var resp = await fetch(data.url);
        var blob = await resp.blob();
        zip.file(keys[i].replace(currentPrefix, ''), blob);
      }
      $1('#loading-text').textContent = 'Creating ZIP...';
      var zipBlob = await zip.generateAsync({ type: 'blob' });
      var zipName = currentPrefix ? currentPrefix.replace(/\/$/, '').split('/').pop() + '.zip' : currentBucket + '.zip';
      saveAs(zipBlob, zipName);
      toast('ZIP download complete', 'success');
    } catch (err) { toast('ZIP failed: ' + err.message, 'error'); }
    finally { hideLoading(); }
  }

  // --- Create Folder ---
  $1('#btn-show-create-folder').addEventListener('click', function() {
    $1('#create-folder-form').style.display = 'flex';
    $1('#new-folder-name').focus();
  });
  $1('#btn-cancel-create-folder').addEventListener('click', function() {
    $1('#create-folder-form').style.display = 'none';
    $1('#new-folder-name').value = '';
  });
  $1('#btn-create-folder').addEventListener('click', async function() {
    var name = $1('#new-folder-name').value.trim();
    if (!name) { toast('Enter a folder name', 'error'); return; }
    var key = currentPrefix + name + '/';
    showLoading('Creating folder...');
    try {
      await api('buckets/' + currentBucket + '/folder', { method: 'POST', body: { key: key } });
      toast('Folder "' + name + '" created', 'success');
      $1('#new-folder-name').value = '';
      $1('#create-folder-form').style.display = 'none';
      loadBucketContents();
    } catch (err) { toast('Failed: ' + err.message, 'error'); }
    finally { hideLoading(); }
  });

  // --- Upload Files ---
  var pendingFiles = null;

  $1('#btn-upload-files').addEventListener('click', function() {
    $1('#file-input').click();
  });
  $1('#file-input').addEventListener('change', function(e) {
    if (e.target.files.length > 0) showUploadModal(e.target.files);
    e.target.value = '';
  });

  function showUploadModal(fileList) {
    pendingFiles = Array.from(fileList);
    var list = $1('#upload-file-list');
    list.innerHTML = pendingFiles.map(function(f) {
      return '<div class="upload-file-item"><span>' + esc(f.name) + '</span><span>' + fmtBytes(f.size) + '</span></div>';
    }).join('');
    var totalSize = pendingFiles.reduce(function(s, f) { return s + f.size; }, 0);
    var recEl = $1('#upload-recommendation');
    if (totalSize >= SIZE_5GB) {
      recEl.innerHTML = '<strong>Large upload (' + fmtBytes(totalSize) + ')</strong> — Browser uploads of this size are unreliable. ' +
        'For best results, use <a href="https://aws.amazon.com/datasync/getting-started/" target="_blank" rel="noopener">AWS DataSync</a> ' +
        'for fast, automated transfers with retry and verification built in.';
      recEl.style.display = 'block';
    } else if (totalSize >= SIZE_500MB) {
      var cmd = pendingFiles.length === 1
        ? 'aws s3 cp ./' + pendingFiles[0].name + ' s3://' + currentBucket + '/' + currentPrefix + pendingFiles[0].name
        : 'aws s3 sync ./ s3://' + currentBucket + '/' + currentPrefix;
      recEl.innerHTML = '<strong>Tip:</strong> For uploads this size (' + fmtBytes(totalSize) + '), the AWS CLI is faster and more reliable:' +
        '<code onclick="navigator.clipboard.writeText(this.textContent).then(function(){});" title="Click to copy">' + esc(cmd) + '</code>';
      recEl.style.display = 'block';
    } else {
      recEl.style.display = 'none';
    }
    $1('#upload-storage-class').value = 'INTELLIGENT_TIERING';
    $1('#upload-archive-optin').checked = false;
    toggleUploadArchiveOptin();
    $1('#upload-modal').classList.add('active');
  }

  function toggleUploadArchiveOptin() {
    var sel = $1('#upload-storage-class').value;
    $1('#upload-archive-optin-label').style.display = sel === 'INTELLIGENT_TIERING' ? 'inline-flex' : 'none';
    if (sel !== 'INTELLIGENT_TIERING') $1('#upload-archive-optin').checked = false;
  }
  $1('#upload-storage-class').addEventListener('change', toggleUploadArchiveOptin);

  $1('#upload-cancel').addEventListener('click', function() {
    $1('#upload-modal').classList.remove('active');
    pendingFiles = null;
  });

  $1('#upload-confirm').addEventListener('click', async function() {
    if (!pendingFiles || pendingFiles.length === 0) return;
    var storageClass = $1('#upload-storage-class').value;
    var archiveOptIn = $1('#upload-archive-optin').checked;
    $1('#upload-modal').classList.remove('active');
    await uploadFiles(pendingFiles, storageClass, archiveOptIn);
    pendingFiles = null;
  });

  async function uploadFiles(files, storageClass, archiveOptIn) {
    showLoading('Uploading ' + files.length + ' file(s)...');
    try {
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        $1('#loading-text').textContent = 'Uploading ' + (i + 1) + ' of ' + files.length + ': ' + file.name;
        var key = currentPrefix + file.name;
        var data = await api('buckets/' + currentBucket + '/upload-url', {
          method: 'POST',
          body: { key: key, contentType: file.type || 'application/octet-stream', storageClass: storageClass }
        });
        await fetch(data.url, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': file.type || 'application/octet-stream' }
        });
      }
      if (storageClass === 'INTELLIGENT_TIERING' && archiveOptIn) {
        try {
          await api('buckets/' + currentBucket + '/change-tier', {
            method: 'POST',
            body: { key: '', storageClass: 'INTELLIGENT_TIERING', archiveOptIn: true, skipCopy: true }
          });
        } catch (e) { /* best effort */ }
      }
      toast(files.length + ' file(s) uploaded', 'success');
      loadBucketContents();
    } catch (err) { toast('Upload failed: ' + err.message, 'error'); }
    finally { hideLoading(); }
  }

  // --- Drag and Drop ---
  var dropZone = $1('#drop-zone');
  if (dropZone) {
    ['dragenter', 'dragover'].forEach(function(evt) {
      dropZone.addEventListener(evt, function(e) {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('drag-over');
      });
    });
    ['dragleave', 'drop'].forEach(function(evt) {
      dropZone.addEventListener(evt, function(e) {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');
      });
    });
    dropZone.addEventListener('drop', function(e) {
      var files = e.dataTransfer.files;
      if (files.length > 0) showUploadModal(files);
    });
    dropZone.addEventListener('click', function() {
      $1('#file-input').click();
    });
  }

  // --- Logout ---
  $1('#btn-logout').addEventListener('click', function(e) {
    e.preventDefault();
    logout();
  });

  // --- Init: check auth and show user email ---
  async function init() {
    var idToken = getIdToken();
    if (!idToken) { logout(); return; }

    var email = getEmailFromToken(idToken);
    if (email) {
      $1('#auth-user').textContent = email;
    }

    try {
      await initCredentials();
      loadAccountInfo();
      var route = parseHash();
      window.navigateTo(route.view, route.params);
    } catch (err) {
      console.error('Auth init failed:', err);
      logout();
    }
  }

  window.addEventListener('popstate', function() {
    var route = parseHash();
    window.navigateTo(route.view, route.params);
  });

  init();
})();

/**
 * Mapa CDVs RS - Aplicação Frontend
 * Visualizador Interativo e Busca de CDVs Credenciados Detran-RS por Proximidade
 */

let allCdvs = [];
let filteredCdvs = [];
let citiesRs = {};
let map = null;
let markerCluster = null;
let userMarker = null;
let userLocation = null; // { lat, lng, label }
const markersMap = new Map(); // codigo -> L.marker

const CARDS_PER_PAGE = 30;
let visibleCount = CARDS_PER_PAGE;

// LocalStorage Keys & State
const STORAGE_KEY_FAVORITES = 'mapa_cdvs_favorites';
const STORAGE_KEY_SEEN = 'mapa_cdvs_seen';
const STORAGE_KEY_WA_MSG = 'mapa_cdvs_wa_msg';
let favoritesSet = new Set();
let seenSet = new Set();
let currentQuickFilter = 'all'; // 'all' | 'favorites' | 'unseen'

// Coordenadas Centrais e Limites de Navegação
const RS_CENTER = [-29.8, -53.2];
const RS_INITIAL_ZOOM = 7;

// Limites expandidos (+100% largura e +50% altura) para evitar o efeito de 'quadrado flutuante' e exibir contexto geográfico
const MAP_BOUNDS = [
  [-36.5, -63.0], // Sudoeste (Uruguai, Argentina e Sul)
  [-24.0, -45.0]  // Nordeste (Santa Catarina, Paraná e Oceano Atlântico)
];

document.addEventListener('DOMContentLoaded', () => {
  loadStorageData();
  initMap();
  loadData();
  setupEventListeners();
  setupPhoneMask();
  setupWhatsAppMsgListeners();
});

/* ==========================================================================
   LocalStorage (Favoritos & Já Vistos)
   ========================================================================== */
function loadStorageData() {
  try {
    const favs = JSON.parse(localStorage.getItem(STORAGE_KEY_FAVORITES) || '[]');
    if (Array.isArray(favs)) favoritesSet = new Set(favs);
  } catch (e) {
    favoritesSet = new Set();
  }
  try {
    const seen = JSON.parse(localStorage.getItem(STORAGE_KEY_SEEN) || '[]');
    if (Array.isArray(seen)) seenSet = new Set(seen);
  } catch (e) {
    seenSet = new Set();
  }
  updateFavCount();
}

function saveFavorites() {
  localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(Array.from(favoritesSet)));
  updateFavCount();
}

function saveSeen() {
  localStorage.setItem(STORAGE_KEY_SEEN, JSON.stringify(Array.from(seenSet)));
}

function updateFavCount() {
  const el = document.getElementById('fav-count');
  if (el) el.textContent = favoritesSet.size;
}

function isFavorite(codigo) {
  return favoritesSet.has(codigo);
}

function toggleFavorite(codigo) {
  if (favoritesSet.has(codigo)) {
    favoritesSet.delete(codigo);
    showToast('Removido dos favoritos');
  } else {
    favoritesSet.add(codigo);
    showToast('Adicionado aos favoritos ❤️');
  }
  saveFavorites();
  applyFilters();
}

function isSeen(codigo) {
  return seenSet.has(codigo);
}

function toggleSeen(codigo) {
  if (seenSet.has(codigo)) {
    seenSet.delete(codigo);
    showToast('Marcado como não visto');
  } else {
    seenSet.add(codigo);
    showToast('Marcado como visto 👁️');
  }
  saveSeen();
  applyFilters();
}

function setQuickFilter(type) {
  currentQuickFilter = type;
  document.querySelectorAll('.filter-chips .chip').forEach(btn => btn.classList.remove('active'));
  const activeBtn = document.getElementById(`chip-filter-${type}`);
  if (activeBtn) activeBtn.classList.add('active');
  applyFilters();
}

/* ==========================================================================
   Utilitários (Debounce, Sanitização e Escape)
   ========================================================================== */
function debounce(func, wait = 250) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function sanitizeUrl(url) {
  if (!url) return '';
  const trimmed = String(url).trim();
  if (/^(https?:\/\/|tel:)/i.test(trimmed)) {
    return trimmed;
  }
  return '#';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ==========================================================================
   Inicialização do Mapa (Leaflet + MarkerCluster)
   ========================================================================== */
function initMap() {
  map = L.map('map', {
    center: RS_CENTER,
    zoom: RS_INITIAL_ZOOM,
    minZoom: 6,
    maxBounds: MAP_BOUNDS,
    maxBoundsViscosity: 0.8,
    zoomControl: true,
  });

  // Camada OpenStreetMap (sem restrição artificial de bounds para preencher o viewport naturalmente)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | Dados: Detran-RS',
    minZoom: 6,
    maxZoom: 19,
  }).addTo(map);

  // Agrupador de marcadores (MarkerCluster)
  markerCluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 45,
    spiderfyOnMaxZoom: true,
    disableClusteringAtZoom: 16
  });
  map.addLayer(markerCluster);
}

function resetMapView() {
  if (userLocation) {
    map.flyTo([userLocation.lat, userLocation.lng], 11);
  } else {
    map.flyTo(RS_CENTER, RS_INITIAL_ZOOM);
  }
}

/* ==========================================================================
   Carregamento de Dados (JSONs)
   ========================================================================== */
async function loadData() {
  try {
    // 1. Carrega CDVs
    const cdvResponse = await fetch('data/cdvs.json');
    if (cdvResponse.ok) {
      allCdvs = await cdvResponse.json();
    } else {
      console.warn('cdvs.json não encontrado ou vazio, tentando novamente...');
    }

    // 2. Carrega Cidades do RS
    try {
      const citiesResponse = await fetch('data/cities_rs.json');
      if (citiesResponse.ok) {
        citiesRs = await citiesResponse.json();
        populateCitiesDatalist();
      }
    } catch (e) {
      console.warn('Não foi possível carregar cities_rs.json:', e);
    }

    // 3. Carrega Metadata
    try {
      const metaResponse = await fetch('data/metadata.json');
      if (metaResponse.ok) {
        const meta = await metaResponse.json();
        const dateStr = meta.ultima_atualizacao ? new Date(meta.ultima_atualizacao).toLocaleDateString('pt-BR') : '';
        const countBadge = document.getElementById('total-cdvs-count');
        if (countBadge) {
          countBadge.textContent = `${allCdvs.length} CDVs Credenciados (${dateStr})`;
        }
      } else {
        const countBadge = document.getElementById('total-cdvs-count');
        if (countBadge) countBadge.textContent = `${allCdvs.length} CDVs Credenciados`;
      }
    } catch (e) {
      const countBadge = document.getElementById('total-cdvs-count');
      if (countBadge) countBadge.textContent = `${allCdvs.length} CDVs Credenciados`;
    }

    // Renderiza inicialmente
    applyFilters();

  } catch (error) {
    console.error('Erro ao carregar dados:', error);
    document.getElementById('cdv-list').innerHTML = `
      <div class="empty-state">
        <p>⚠️ Erro ao carregar a lista de credenciados.</p>
        <p style="font-size: 0.8rem; margin-top: 6px;">Verifique se a base de dados foi gerada.</p>
      </div>
    `;
  }
}

/* ==========================================================================
   Datalist e Picker de Cidades do RS (Substituído por busca unificada)
   ========================================================================== */
function populateCitiesDatalist() {
  // A busca por cidade foi integrada diretamente no campo de busca textual unificado
}

/* ==========================================================================
   Event Listeners e Interações de Busca
   ========================================================================== */
function setupEventListeners() {
  const textSearch = document.getElementById('text-search');
  const btnClearSearch = document.getElementById('btn-clear-search');

  if (textSearch) {
    const debouncedFilter = debounce(() => {
      applyFilters();
    }, 250);

    textSearch.addEventListener('input', (e) => {
      if (btnClearSearch) {
        btnClearSearch.style.display = e.target.value.length > 0 ? 'block' : 'none';
      }
      debouncedFilter();
    });
  }

  // Monitorar scroll da lista para exibir botão 'Voltar ao Topo'
  const listEl = document.getElementById('cdv-list');
  const backToTopBtn = document.getElementById('btn-back-to-top');
  if (listEl && backToTopBtn) {
    listEl.addEventListener('scroll', () => {
      if (listEl.scrollTop > 200) {
        backToTopBtn.classList.add('visible');
      } else {
        backToTopBtn.classList.remove('visible');
      }
    });
  }

  // Tecla Esc fecha modais
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeContactModal();
      closeSuggestModal();
    }
  });
}

function clearSearchText() {
  const textSearch = document.getElementById('text-search');
  const btnClearSearch = document.getElementById('btn-clear-search');
  if (textSearch) {
    textSearch.value = '';
    textSearch.focus();
  }
  if (btnClearSearch) {
    btnClearSearch.style.display = 'none';
  }
  applyFilters();
}

function scrollToTopList() {
  const listEl = document.getElementById('cdv-list');
  if (listEl) {
    listEl.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function setupPhoneMask() {
  const phoneInput = document.getElementById('suggest-phone');
  if (!phoneInput) return;

  phoneInput.addEventListener('input', (e) => {
    let val = e.target.value.replace(/\D/g, '');

    // Se começar com zero e tiver mais de 2 dígitos (ex: 051...), remove o 0 inicial automaticamente
    if (val.startsWith('0') && val.length > 2) {
      val = val.replace(/^0+/, '');
    }

    if (val.length > 11) val = val.slice(0, 11);

    if (val.length > 6) {
      if (val.length === 11) {
        e.target.value = `(${val.slice(0, 2)}) ${val.slice(2, 7)}-${val.slice(7)}`;
      } else {
        e.target.value = `(${val.slice(0, 2)}) ${val.slice(2, 6)}-${val.slice(6)}`;
      }
    } else if (val.length > 2) {
      e.target.value = `(${val.slice(0, 2)}) ${val.slice(2)}`;
    } else if (val.length > 0) {
      e.target.value = `(${val}`;
    } else {
      e.target.value = '';
    }
  });

  // Tratamento específico no evento paste para limpar zeros à esquerda imediatamente
  phoneInput.addEventListener('paste', () => {
    setTimeout(() => {
      let val = phoneInput.value.replace(/\D/g, '');
      if (val.startsWith('0') && val.length > 2) {
        val = val.replace(/^0+/, '');
      }
      if (val.length > 11) val = val.slice(0, 11);
      if (val.length === 11) {
        phoneInput.value = `(${val.slice(0, 2)}) ${val.slice(2, 7)}-${val.slice(7)}`;
      } else if (val.length === 10) {
        phoneInput.value = `(${val.slice(0, 2)}) ${val.slice(2, 6)}-${val.slice(6)}`;
      }
    }, 10);
  });
}

/* ==========================================================================
   Geolocalização do Usuário (Toggle Inteligente de GPS)
   ========================================================================== */
function toggleUserGPSLocation() {
  if (userLocation) {
    clearLocationFilter();
  } else {
    getUserGPSLocation();
  }
}

function getUserGPSLocation() {
  const btn = document.getElementById('btn-gps');
  const textEl = document.getElementById('btn-gps-text');

  if (!navigator.geolocation) {
    alert('Geolocalização não é suportada pelo seu navegador.');
    return;
  }

  if (btn) btn.classList.add('loading');
  if (textEl) textEl.textContent = 'Obtendo localização...';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (btn) {
        btn.classList.remove('loading');
        btn.classList.add('is-active');
      }
      if (textEl) textEl.textContent = '📍 Localização GPS ativa • Desativar ✕';

      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;

      setUserLocation(lat, lng, 'Sua localização atual (GPS)');
    },
    (err) => {
      if (btn) {
        btn.classList.remove('loading');
        btn.classList.remove('is-active');
      }
      if (textEl) textEl.textContent = 'Usar minha localização (GPS)';
      console.warn('Erro ao obter GPS:', err);
      alert('Não foi possível obter sua localização. Você pode pesquisar sua cidade diretamente no campo de busca.');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

function setUserLocation(lat, lng, label) {
  userLocation = { lat, lng, label };

  const btn = document.getElementById('btn-gps');
  const textEl = document.getElementById('btn-gps-text');
  if (btn) btn.classList.add('is-active');
  if (textEl) textEl.textContent = '📍 Localização GPS ativa • Desativar ✕';

  if (userMarker) {
    map.removeLayer(userMarker);
  }

  const userIcon = L.divIcon({
    className: 'user-gps-marker',
    html: `
      <div style="background-color: #1D4ED8; width: 18px; height: 18px; border-radius: 50%; border: 3px solid #FFF; box-shadow: 0 0 10px rgba(29,78,216,0.7); position: relative;">
        <div style="position: absolute; top: -6px; left: -6px; width: 24px; height: 24px; border-radius: 50%; background-color: rgba(29,78,216,0.25); animation: pulse-gps 1.5s infinite;"></div>
      </div>
    `,
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });

  userMarker = L.marker([lat, lng], { icon: userIcon, zIndexOffset: 1000 })
    .addTo(map)
    .bindPopup(`<strong>📍 ${label}</strong><br><span style="font-size:0.75rem; color:#475569;">Ponto de referência para distâncias</span>`);

  map.flyTo([lat, lng], 11, { duration: 1.2 });

  applyFilters();

  scrollToTopList();
}

function clearLocationFilter() {
  userLocation = null;

  const btn = document.getElementById('btn-gps');
  const textEl = document.getElementById('btn-gps-text');
  if (btn) {
    btn.classList.remove('is-active');
    btn.classList.remove('loading');
  }
  if (textEl) textEl.textContent = 'Usar minha localização (GPS)';

  if (userMarker) {
    map.removeLayer(userMarker);
    userMarker = null;
  }

  resetMapView();
  applyFilters();
}

/* ==========================================================================
   Fórmula de Haversine (Cálculo de Distância em km)
   ========================================================================== */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/* ==========================================================================
   Obtenção do Link de Rota Prioritário
   (Prioriza o link exato do Detran; usa coordenadas GPS como fallback)
   ========================================================================== */
function getRouteUrl(cdv) {
  if (cdv.maps_url && cdv.maps_url.trim()) {
    return sanitizeUrl(cdv.maps_url);
  }
  if (cdv.lat && cdv.lng) {
    return sanitizeUrl(`https://www.google.com/maps/dir/?api=1&destination=${cdv.lat},${cdv.lng}`);
  }
  return '#';
}

/* ==========================================================================
   Filtros, Ordenação e Atualização
   ========================================================================== */
function applyFilters() {
  const searchInput = document.getElementById('text-search');
  const searchTerm = searchInput ? searchInput.value.trim().toLowerCase() : '';

  visibleCount = CARDS_PER_PAGE;

  filteredCdvs = allCdvs.map(cdv => {
    let distance = null;
    if (userLocation && cdv.lat && cdv.lng) {
      distance = calculateDistance(userLocation.lat, userLocation.lng, cdv.lat, cdv.lng);
    }
    return { ...cdv, distance };
  }).filter(cdv => {
    // 1. Filtro rápido de LocalStorage (Favoritos / Ocultar Vistos)
    if (currentQuickFilter === 'favorites' && !isFavorite(cdv.codigo)) {
      return false;
    }
    if (currentQuickFilter === 'unseen' && isSeen(cdv.codigo)) {
      return false;
    }

    // 2. Filtro textual (unificado: nome, código, cidade, bairro, endereço)
    if (searchTerm) {
      const matchName = (cdv.nome || '').toLowerCase().includes(searchTerm);
      const matchCode = (cdv.codigo || '').toLowerCase().includes(searchTerm);
      const matchCity = (cdv.municipio || '').toLowerCase().includes(searchTerm);
      const matchBairro = (cdv.bairro || '').toLowerCase().includes(searchTerm);
      const matchEnd = (cdv.endereco || '').toLowerCase().includes(searchTerm);
      const matchExtra = (cdv.contatos_extras || []).some(extra =>
        (extra.nome || '').toLowerCase().includes(searchTerm) ||
        (extra.telefone || '').includes(searchTerm)
      );
      if (!matchName && !matchCode && !matchCity && !matchBairro && !matchEnd && !matchExtra) {
        return false;
      }
    }

    return true;
  });

  // Ordenação
  if (userLocation) {
    filteredCdvs.sort((a, b) => {
      if (a.distance === null) return 1;
      if (b.distance === null) return -1;
      return a.distance - b.distance;
    });
    const sortInfo = document.getElementById('sort-info');
    if (sortInfo) sortInfo.textContent = 'Mais próximos primeiro 📍';
  } else {
    filteredCdvs.sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR'));
    const sortInfo = document.getElementById('sort-info');
    if (sortInfo) sortInfo.textContent = 'Ordem alfabética';
  }

  const countText = `Exibindo ${filteredCdvs.length} de ${allCdvs.length} CDVs`;
  const resultsCount = document.getElementById('results-count');
  if (resultsCount) resultsCount.textContent = countText;
  const mobileCount = document.getElementById('mobile-count');
  if (mobileCount) mobileCount.textContent = filteredCdvs.length;

  updateFavCount();
  renderList();
  renderMarkers();
}

function renderExtraContactButton(extra, cdvNome, isPopup = false) {
  const tipo = (extra.tipo || (extra.whatsapp ? 'whatsapp' : 'phone')).toLowerCase();
  const nome = escapeHtml(extra.nome || 'Contato Extra');
  const labelText = extra.telefone_formatado || extra.telefone || extra.nome;
  const fontSizeStyle = isPopup ? 'font-size:0.72rem; padding:5px 8px;' : '';
  const imgSizeStyle = isPopup ? 'width:13px; height:13px;' : 'width:15px; height:15px;';

  if (tipo === 'whatsapp') {
    const rawNumber = extra.telefone || '';
    const formatted = extra.telefone_formatado || extra.telefone;
    const url = extra.whatsapp_url || extra.url || (rawNumber ? `https://api.whatsapp.com/send?phone=55${rawNumber.replace(/\D+/g, '')}` : '');
    return `
      <button type="button" class="btn-extra-contact is-whatsapp" style="${fontSizeStyle}" onclick="handleContactClick('whatsapp', '${escapeHtml(formatted)}', '${escapeHtml(cdvNome)} (${nome})', '${sanitizeUrl(url)}')" title="WhatsApp: ${nome}">
        <img src="assets/whatsapp.png" alt="" class="btn-icon-img" style="${imgSizeStyle}"> ${isPopup ? nome : `${nome}: ${escapeHtml(formatted)}`}
      </button>
    `;
  }

  if (tipo === 'instagram') {
    const handle = extra.telefone_formatado || extra.telefone || extra.nome;
    const url = sanitizeUrl(extra.url || (handle ? `https://www.instagram.com/${handle.replace(/^@/, '')}/` : '#'));
    return `
      <a href="${url}" target="_blank" rel="noopener noreferrer" class="btn-extra-contact is-instagram" style="${fontSizeStyle}" title="Instagram: ${nome}">
        <img src="assets/instagram.png" alt="" class="btn-icon-img" style="${imgSizeStyle}"> ${isPopup ? nome : `Instagram: ${escapeHtml(handle)}`}
      </a>
    `;
  }

  if (tipo === 'facebook') {
    const handle = extra.telefone_formatado || extra.telefone || extra.nome;
    const url = sanitizeUrl(extra.url || (handle ? `https://www.facebook.com/${handle}` : '#'));
    return `
      <a href="${url}" target="_blank" rel="noopener noreferrer" class="btn-extra-contact is-facebook" style="${fontSizeStyle}" title="Facebook: ${nome}">
        <img src="assets/facebook.png" alt="" class="btn-icon-img" style="${imgSizeStyle}"> ${isPopup ? nome : `Facebook: ${escapeHtml(handle)}`}
      </a>
    `;
  }

  // Telefone padrão (ligação)
  const phoneClean = (extra.telefone || '').replace(/\D+/g, '');
  const formatted = extra.telefone_formatado || extra.telefone;
  return `
    <button type="button" class="btn-extra-contact is-phone" style="${fontSizeStyle}" onclick="handleContactClick('phone', '${escapeHtml(formatted)}', '${escapeHtml(cdvNome)} (${nome})', 'tel:${phoneClean}')" title="Telefone: ${nome}">
      📞 ${isPopup ? nome : `${nome}: ${escapeHtml(formatted)}`}
    </button>
  `;
}

function createCardElement(cdv) {
  const card = document.createElement('article');
  card.id = `card-${cdv.codigo}`;

  const favorite = isFavorite(cdv.codigo);
  const seen = isSeen(cdv.codigo);

  card.className = `cdv-card ${favorite ? 'is-favorite' : ''} ${seen ? 'is-seen' : ''}`;

  const distanceBadge = cdv.distance !== null
    ? `<span class="badge-distance" title="Distância em linha reta">📍 ${cdv.distance < 10 ? cdv.distance.toFixed(1) : Math.round(cdv.distance)} km</span>`
    : '';

  // WhatsApp e Telefone com acionamento do Popup de Confirmação (Abrir / Copiar)
  const safeWaUrl = sanitizeUrl(cdv.whatsapp_url);
  const whatsappBtn = (safeWaUrl && safeWaUrl !== '#') || cdv.whatsapp
    ? `<button type="button" class="btn-action btn-whatsapp" onclick="handleContactClick('whatsapp', '${escapeHtml(cdv.whatsapp || '')}', '${escapeHtml(cdv.nome)}', '${safeWaUrl}')" title="Conversar via WhatsApp"><img src="assets/whatsapp.png" alt="" class="btn-icon-img"> WhatsApp</button>`
    : '';

  const phoneClean = (cdv.telefone || '').replace(/\D+/g, '');
  const phoneBtn = phoneClean
    ? `<button type="button" class="btn-action btn-phone" onclick="handleContactClick('phone', '${escapeHtml(cdv.telefone)}', '${escapeHtml(cdv.nome)}', 'tel:${phoneClean}')" title="Ligar para ${escapeHtml(cdv.telefone)}">📞 ${escapeHtml(cdv.telefone)}</button>`
    : '';

  // Link de rota prioritário do Detran
  const routeUrl = getRouteUrl(cdv);
  const routeBtn = routeUrl && routeUrl !== '#'
    ? `<a href="${routeUrl}" target="_blank" rel="noopener noreferrer" class="btn-action btn-route" title="Ver rota ou localização no Google Maps">🗺️ Como Chegar</a>`
    : '';

  // Contatos Extras Aprovados (se houver)
  let extraContactsHtml = '';
  if (Array.isArray(cdv.contatos_extras) && cdv.contatos_extras.length > 0) {
    const extraButtons = cdv.contatos_extras.map(extra => renderExtraContactButton(extra, cdv.nome)).join('');
    extraContactsHtml = `
      <div class="extra-contacts-box">
        ${extraButtons}
      </div>
    `;
  }

  card.innerHTML = `
    <div class="card-header">
      <h3 class="card-title">${escapeHtml(cdv.nome)}</h3>
      <div class="card-top-actions">
        <button type="button" class="btn-card-icon" onclick="downloadVCardFromCard('${escapeHtml(cdv.codigo)}')" title="Baixar contato (.vcf) para sua agenda" aria-label="Salvar contato">📇</button>
        <button type="button" class="btn-card-icon btn-seen-toggle" onclick="toggleSeen('${escapeHtml(cdv.codigo)}')" title="${seen ? 'Marcar como não visto' : 'Marcar como visto'}" aria-label="Marcar visto">${seen ? '👁️' : '👁️‍🗨️'}</button>
        <button type="button" class="btn-card-icon btn-fav-toggle ${favorite ? 'active' : ''}" onclick="toggleFavorite('${escapeHtml(cdv.codigo)}')" title="${favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}" aria-label="Favoritar">${favorite ? '❤️' : '🤍'}</button>
      </div>
    </div>
    <div class="card-location-row">
      <span class="card-city">📍 ${escapeHtml(cdv.municipio || 'RS')}</span>
      ${distanceBadge}
    </div>
    <div class="card-address">
      ${escapeHtml(cdv.endereco || 'Endereço não informado')}${cdv.complemento ? ` (${escapeHtml(cdv.complemento)})` : ''}${cdv.bairro ? ` • ${escapeHtml(cdv.bairro)}` : ''}
    </div>
    <div class="card-secondary-meta">
      <span class="meta-code" title="Código de Credenciamento DETRAN">${escapeHtml(cdv.codigo)}</span>
      ${cdv.cep ? `<span>CEP: ${escapeHtml(cdv.cep)}</span>` : ''}
      ${seen ? '<span class="meta-seen">Visto</span>' : ''}
    </div>
    ${extraContactsHtml}
    <div class="card-actions">
      ${whatsappBtn}
      ${routeBtn}
      ${phoneBtn}
    </div>
    <div class="card-suggest-box">
      <button type="button" class="btn-suggest" onclick="openSuggestModalFromCard('${escapeHtml(cdv.codigo)}')">
        💡 Sugerir contato para este CDV
      </button>
    </div>
  `;

  card.addEventListener('click', (e) => {
    if (e.target.closest('a') || e.target.closest('button')) return;
    focusCdvOnMap(cdv);
  });

  return card;
}

/* ==========================================================================
   Renderização dos Cards na Lista (Lazy Load / Paginação)
   ========================================================================== */
function renderList() {
  const container = document.getElementById('cdv-list');
  container.innerHTML = '';

  if (filteredCdvs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>🔍 Nenhum CDV encontrado com os filtros atuais.</p>
        <p style="font-size: 0.8rem; margin-top: 6px;">Tente alterar os filtros rápidos, aumentar o raio ou limpar a busca textual.</p>
      </div>
    `;
    return;
  }

  const fragment = document.createDocumentFragment();
  const slice = filteredCdvs.slice(0, visibleCount);

  slice.forEach(cdv => {
    fragment.appendChild(createCardElement(cdv));
  });

  if (filteredCdvs.length > visibleCount) {
    const remaining = filteredCdvs.length - visibleCount;
    const nextBatch = Math.min(CARDS_PER_PAGE, remaining);
    const loadMoreWrapper = document.createElement('div');
    loadMoreWrapper.className = 'load-more-container';
    loadMoreWrapper.innerHTML = `
      <button type="button" class="btn-load-more" onclick="loadMoreCards()">
        ➕ Carregar mais ${nextBatch} CDVs (${remaining} restantes)
      </button>
    `;
    fragment.appendChild(loadMoreWrapper);
  }

  container.appendChild(fragment);
}

function loadMoreCards() {
  visibleCount += CARDS_PER_PAGE;
  renderList();
}

/* ==========================================================================
   Renderização dos Pins no Mapa (com Suporte a Favorito & Já Visto)
   ========================================================================== */
function renderMarkers() {
  markerCluster.clearLayers();
  markersMap.clear();

  const markersToAdd = [];

  filteredCdvs.forEach(cdv => {
    if (!cdv.lat || !cdv.lng) return;

    const favorite = isFavorite(cdv.codigo);
    const seen = isSeen(cdv.codigo);

    let pinWrapperClass = 'custom-pin-wrapper';
    if (seen) pinWrapperClass += ' pin-seen-wrapper';
    if (favorite) pinWrapperClass += ' pin-favorite-wrapper';

    const pinInnerClass = `custom-pin ${favorite ? 'pin-favorite-marker' : ''}`;
    const pinIconSymbol = favorite ? '❤️' : '🔧';

    const pinIcon = L.divIcon({
      className: pinWrapperClass,
      html: `<div class="${pinInnerClass}"><span>${pinIconSymbol}</span></div>`,
      iconSize: [38, 38],
      iconAnchor: [19, 38],
      popupAnchor: [0, -36]
    });

    const marker = L.marker([cdv.lat, cdv.lng], {
      icon: pinIcon,
      zIndexOffset: favorite ? 500 : 0
    });

    const distanceBadge = cdv.distance !== null
      ? `<span class="badge-distance" title="Distância em linha reta">📍 ${cdv.distance < 10 ? cdv.distance.toFixed(1) : Math.round(cdv.distance)} km</span>`
      : '';

    const safeWaUrl = sanitizeUrl(cdv.whatsapp_url);
    const whatsappBtn = (safeWaUrl && safeWaUrl !== '#') || cdv.whatsapp
      ? `<button type="button" class="btn-action btn-whatsapp" style="font-size:0.75rem;" onclick="handleContactClick('whatsapp', '${escapeHtml(cdv.whatsapp || '')}', '${escapeHtml(cdv.nome)}', '${safeWaUrl}')"><img src="assets/whatsapp.png" alt="" class="btn-icon-img" style="width:13px;height:13px;"> WhatsApp</button>`
      : '';

    const phoneClean = (cdv.telefone || '').replace(/\D+/g, '');
    const phoneBtn = phoneClean
      ? `<button type="button" class="btn-action btn-phone" style="font-size:0.75rem;" onclick="handleContactClick('phone', '${escapeHtml(cdv.telefone)}', '${escapeHtml(cdv.nome)}', 'tel:${phoneClean}')">📞 ${escapeHtml(cdv.telefone)}</button>`
      : '';

    const routeUrl = getRouteUrl(cdv);
    const routeBtn = routeUrl && routeUrl !== '#'
      ? `<a href="${routeUrl}" target="_blank" rel="noopener noreferrer" class="btn-action btn-route" style="font-size:0.75rem;">🗺️ Rota</a>`
      : '';

    // Contatos extras no popup do mapa
    let popupExtraContactsHtml = '';
    if (Array.isArray(cdv.contatos_extras) && cdv.contatos_extras.length > 0) {
      const extraBtns = cdv.contatos_extras.map(extra => renderExtraContactButton(extra, cdv.nome, true)).join('');
      popupExtraContactsHtml = `<div class="extra-contacts-box" style="margin-top:6px; margin-bottom:6px;">${extraBtns}</div>`;
    }

    const popupContent = `
      <div class="popup-card">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
          <h4 class="popup-title">${escapeHtml(cdv.nome)}</h4>
          <div class="card-top-actions">
            <button type="button" class="btn-card-icon" onclick="downloadVCardFromCard('${escapeHtml(cdv.codigo)}')" title="Salvar contato" aria-label="Salvar contato">📇</button>
            <button type="button" class="btn-card-icon btn-seen-toggle" onclick="toggleSeen('${escapeHtml(cdv.codigo)}')" title="${seen ? 'Marcar como não visto' : 'Marcar como visto'}">${seen ? '👁️' : '👁️‍🗨️'}</button>
            <button type="button" class="btn-card-icon btn-fav-toggle ${favorite ? 'active' : ''}" onclick="toggleFavorite('${escapeHtml(cdv.codigo)}')" title="${favorite ? 'Remover dos favoritos' : 'Favoritar'}">${favorite ? '❤️' : '🤍'}</button>
          </div>
        </div>
        <div class="card-location-row" style="margin-bottom: 4px;">
          <span class="card-city" style="font-size:0.84rem;">📍 ${escapeHtml(cdv.municipio || 'RS')}</span>
          ${distanceBadge}
        </div>
        <div class="popup-address">
          ${escapeHtml(cdv.endereco || '')}${cdv.complemento ? ` (${escapeHtml(cdv.complemento)})` : ''}${cdv.bairro ? ` • ${escapeHtml(cdv.bairro)}` : ''}
        </div>
        <div class="card-secondary-meta" style="margin-bottom: 6px;">
          <span class="meta-code">${escapeHtml(cdv.codigo)}</span>
          ${cdv.cep ? `<span>CEP: ${escapeHtml(cdv.cep)}</span>` : ''}
        </div>
        ${popupExtraContactsHtml}
        <div class="popup-actions">
          ${whatsappBtn}
          ${routeBtn}
          ${phoneBtn}
        </div>
        <div class="popup-suggest-box">
          <button type="button" class="btn-suggest" onclick="openSuggestModalFromCard('${escapeHtml(cdv.codigo)}')">
            💡 Sugerir contato
          </button>
        </div>
      </div>
    `;

    marker.bindPopup(popupContent);

    marker.on('click', () => {
      highlightCardInList(cdv.codigo);
    });

    markersToAdd.push(marker);
    markersMap.set(cdv.codigo, marker);
  });

  markerCluster.addLayers(markersToAdd);
}

/* ==========================================================================
   Interatividade Bidirecional Mapa <-> Lista
   ========================================================================== */
function focusCdvOnMap(cdv) {
  if (!cdv.lat || !cdv.lng) return;

  if (window.innerWidth <= 768) {
    setMobileView('map');
  }

  map.flyTo([cdv.lat, cdv.lng], 16, { duration: 1 });

  const marker = markersMap.get(cdv.codigo);
  if (marker) {
    setTimeout(() => {
      markerCluster.zoomToShowLayer(marker, () => {
        marker.openPopup();
      });
    }, 600);
  }

  highlightCardInList(cdv.codigo);
}

function highlightCardInList(codigo) {
  const cardIndex = filteredCdvs.findIndex(c => c.codigo === codigo);
  if (cardIndex >= visibleCount) {
    visibleCount = Math.ceil((cardIndex + 1) / CARDS_PER_PAGE) * CARDS_PER_PAGE;
    renderList();
  }

  document.querySelectorAll('.cdv-card').forEach(c => c.classList.remove('selected'));
  const card = document.getElementById(`card-${codigo}`);
  if (card) {
    card.classList.add('selected');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

/* ==========================================================================
   Modo Mobile (Abas Mapa / Lista)
   ========================================================================== */
function setMobileView(view) {
  const container = document.querySelector('.main-content');
  const btnList = document.getElementById('tab-btn-list');
  const btnMap = document.getElementById('tab-btn-map');

  if (view === 'map') {
    container.classList.remove('view-list');
    container.classList.add('view-map');
    btnList.classList.remove('active');
    btnMap.classList.add('active');
    setTimeout(() => {
      map.invalidateSize();
    }, 200);
  } else {
    container.classList.remove('view-map');
    container.classList.add('view-list');
    btnMap.classList.remove('active');
    btnList.classList.add('active');
  }
}

/* ==========================================================================
   Modal de Ação de Contato (Abrir / Copiar)
   ========================================================================== */
let currentContactAction = {
  type: '',
  number: '',
  formattedNumber: '',
  openUrl: ''
};

/* ==========================================================================
   Configuração de Mensagem Pré-definida do WhatsApp (LocalStorage)
   ========================================================================== */
function setupWhatsAppMsgListeners() {
  const textarea = document.getElementById('wa-custom-msg');
  if (!textarea) return;

  // Carrega mensagem salva anteriormente se existir
  const savedMsg = localStorage.getItem(STORAGE_KEY_WA_MSG);
  if (savedMsg !== null) {
    textarea.value = savedMsg;
  }

  // Persiste alterações no LocalStorage em tempo real
  textarea.addEventListener('input', (e) => {
    localStorage.setItem(STORAGE_KEY_WA_MSG, e.target.value);
  });
}

function getWhatsAppPrefillText() {
  const includeCheck = document.getElementById('wa-include-msg');
  const textarea = document.getElementById('wa-custom-msg');
  if (includeCheck && !includeCheck.checked) {
    return '';
  }
  if (!textarea) return '';
  const text = (textarea.value || '').trim();
  // O placeholder é apenas ilustrativo. Envia apenas se o usuário tiver digitado 5 ou mais caracteres
  if (text.length < 5) {
    return '';
  }
  return text;
}

function handleContactClick(tipo, numeroRaw, nomeCdv, openUrl) {
  const modal = document.getElementById('contact-modal');
  const titleEl = document.getElementById('contact-modal-title');
  const nameEl = document.getElementById('contact-modal-target-name');
  const numEl = document.getElementById('contact-modal-number');
  const btnOpen = document.getElementById('btn-contact-open');
  const btnCopy = document.getElementById('btn-contact-copy');
  const waContainer = document.getElementById('wa-message-container');

  const cleanDigits = String(numeroRaw || '').replace(/\D+/g, '');
  let formatted = numeroRaw;
  if (cleanDigits.length === 11) {
    formatted = `(${cleanDigits.slice(0, 2)}) ${cleanDigits.slice(2, 7)}-${cleanDigits.slice(7)}`;
  } else if (cleanDigits.length === 10) {
    formatted = `(${cleanDigits.slice(0, 2)}) ${cleanDigits.slice(2, 6)}-${cleanDigits.slice(6)}`;
  }

  currentContactAction = {
    type: tipo,
    number: cleanDigits || numeroRaw,
    formattedNumber: formatted,
    openUrl: openUrl
  };

  if (tipo === 'whatsapp') {
    titleEl.textContent = '💬 Contato via WhatsApp';
    btnOpen.innerHTML = '<img src="assets/whatsapp.png" alt="" class="btn-icon-img" style="width:16px;height:16px;"> Abrir no WhatsApp';
    btnOpen.className = 'btn-modal-action btn-modal-whatsapp';
    if (waContainer) waContainer.style.display = 'flex';
  } else {
    titleEl.textContent = '📞 Contato Telefônico';
    btnOpen.innerHTML = '📞 Ligar Agora';
    btnOpen.className = 'btn-modal-action btn-modal-primary';
    if (waContainer) waContainer.style.display = 'none';
  }
  btnCopy.className = 'btn-modal-action btn-modal-secondary';

  nameEl.textContent = nomeCdv;
  numEl.textContent = formatted || 'Número não disponível';

  btnOpen.onclick = () => {
    if (tipo === 'whatsapp') {
      const msg = getWhatsAppPrefillText();
      const phoneParam = cleanDigits ? (cleanDigits.startsWith('55') ? cleanDigits : `55${cleanDigits}`) : '';
      let targetUrl = '';
      if (phoneParam) {
        targetUrl = `https://api.whatsapp.com/send?phone=${phoneParam}${msg ? `&text=${encodeURIComponent(msg)}` : ''}`;
      } else if (currentContactAction.openUrl && currentContactAction.openUrl !== '#') {
        const sep = currentContactAction.openUrl.includes('?') ? '&' : '?';
        targetUrl = msg ? `${currentContactAction.openUrl}${sep}text=${encodeURIComponent(msg)}` : currentContactAction.openUrl;
      }
      if (targetUrl) {
        window.open(targetUrl, '_blank', 'noopener,noreferrer');
      }
    } else {
      if (currentContactAction.openUrl && currentContactAction.openUrl !== '#') {
        if (currentContactAction.openUrl.startsWith('tel:')) {
          window.location.href = currentContactAction.openUrl;
        } else {
          window.open(currentContactAction.openUrl, '_blank', 'noopener,noreferrer');
        }
      } else if (cleanDigits) {
        window.location.href = `tel:${cleanDigits}`;
      }
    }
    closeContactModal();
  };

  btnCopy.onclick = () => {
    copyToClipboard(currentContactAction.formattedNumber || currentContactAction.number);
  };

  modal.style.display = 'flex';
}

function closeContactModal() {
  const modal = document.getElementById('contact-modal');
  if (modal) modal.style.display = 'none';
}

function copyToClipboard(text) {
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('Número copiado para a área de transferência! 📋');
      closeContactModal();
    }).catch(() => {
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    showToast('Número copiado para a área de transferência! 📋');
    closeContactModal();
  } catch (e) {
    alert('Número: ' + text);
  }
  document.body.removeChild(textarea);
}

let toastTimeout = null;
function showToast(message) {
  const toast = document.getElementById('toast-notification');
  if (!toast) return;
  toast.textContent = message;
  toast.style.display = 'block';
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.style.display = 'none';
  }, 2800);
}

/* ==========================================================================
   Salvar Contato (.vcf / vCard 3.0)
   ========================================================================== */
function sanitizeVCardField(text) {
  if (!text) return '';
  return String(text).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function downloadVCardFromCard(codigo) {
  const cdv = allCdvs.find(c => c.codigo === codigo);
  if (cdv) downloadVCard(cdv);
}

function downloadVCard(cdv) {
  const name = cdv.nome || 'CDV Credenciado';
  const code = cdv.codigo || '';
  const tel = (cdv.telefone || '').replace(/\D+/g, '');
  const wa = (cdv.whatsapp || '').replace(/\D+/g, '');
  const email = cdv.email || '';
  const street = cdv.endereco || '';
  const bairro = cdv.bairro || '';
  const city = (cdv.municipio || '').replace(/\/RS$/i, '');
  const cep = cdv.cep || '';
  const routeUrl = getRouteUrl(cdv);

  let vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${sanitizeVCardField(name)}${code ? ` (${sanitizeVCardField(code)})` : ''}`,
    `ORG:${sanitizeVCardField(name)};DETRAN-RS CDV`,
    'TITLE:Centro de Desmanche de Veículos Credenciado DETRAN-RS',
  ];

  if (tel) {
    vcard.push(`TEL;TYPE=WORK,VOICE:+55${tel}`);
  }
  if (wa && wa !== tel) {
    vcard.push(`TEL;TYPE=CELL,WHATSAPP:+55${wa}`);
  } else if (wa) {
    vcard.push(`TEL;TYPE=CELL,WHATSAPP:+55${wa}`);
  }

  // Contatos extras aprovados
  if (Array.isArray(cdv.contatos_extras)) {
    cdv.contatos_extras.forEach(extra => {
      const extraClean = (extra.telefone || '').replace(/\D+/g, '');
      if (extraClean) {
        const label = sanitizeVCardField(extra.nome || 'Extra');
        vcard.push(`TEL;TYPE=WORK;X-ABLabel=${label}:+55${extraClean}`);
      }
    });
  }

  if (email) {
    vcard.push(`EMAIL;TYPE=WORK:${email}`);
  }

  vcard.push(`ADR;TYPE=WORK:;;${sanitizeVCardField(street)}${bairro ? ` - ${sanitizeVCardField(bairro)}` : ''};${sanitizeVCardField(city)};RS;${sanitizeVCardField(cep)};Brasil`);

  if (routeUrl && routeUrl !== '#') {
    vcard.push(`URL:${routeUrl}`);
  }

  const notes = `Credenciado DETRAN-RS: ${code}\\nBairro: ${bairro}\\nMunicípio: ${cdv.municipio || ''}`;
  vcard.push(`NOTE:${notes}`);
  vcard.push('END:VCARD');

  const blob = new Blob([vcard.join('\r\n')], { type: 'text/vcard;charset=utf-8;' });
  const cleanFileName = (code ? `${code}_` : '') + name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.vcf';

  // Se estiver em mobile e navegador suportar Web Share API com arquivos, tenta abrir o compartilhador nativo
  if (navigator.canShare && typeof File !== 'undefined') {
    try {
      const vcfFile = new File([blob], cleanFileName, { type: 'text/vcard' });
      if (navigator.canShare({ files: [vcfFile] })) {
        navigator.share({
          files: [vcfFile],
          title: name,
          text: `Contato: ${name} (${code})`
        }).then(() => {
          showToast(`Contato pronto para salvar: ${cleanFileName} 📇`);
        }).catch((err) => {
          // Se o usuário cancelou o compartilhamento, não faz nada; se erro, fallback
          if (err && err.name !== 'AbortError') {
            triggerDirectDownload(blob, cleanFileName);
          }
        });
        return;
      }
    } catch (e) {
      console.warn('Web Share API não suportada para arquivos, usando download direto:', e);
    }
  }

  // Fallback padrão (Desktop ou navegadores sem Web Share)
  triggerDirectDownload(blob, cleanFileName);
}

function triggerDirectDownload(blob, cleanFileName) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = cleanFileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);

  showToast(`Contato baixado: ${cleanFileName} 📇`);
}

/* ==========================================================================
   Modal de Sugestão de Contato
   ========================================================================== */
function openSuggestModalFromCard(codigo) {
  const cdv = allCdvs.find(c => c.codigo === codigo);
  if (cdv) openSuggestModal(cdv);
}

function handleSuggestTypeChange(type) {
  const phoneGroup = document.getElementById('suggest-phone-group');
  const phoneInput = document.getElementById('suggest-phone');
  const socialGroup = document.getElementById('suggest-social-group');
  const socialInput = document.getElementById('suggest-social-val');
  const socialLabel = document.getElementById('suggest-social-label');
  const waCheckGroup = document.getElementById('suggest-whatsapp-check-group');
  const contactNameInput = document.getElementById('suggest-contact-name');

  if (type === 'instagram') {
    if (phoneGroup) phoneGroup.style.display = 'none';
    if (socialGroup) socialGroup.style.display = 'block';
    if (waCheckGroup) waCheckGroup.style.display = 'none';
    if (socialLabel) socialLabel.textContent = 'Perfil no Instagram (@ ou link): *';
    if (socialInput) {
      socialInput.placeholder = '@nomedocdv ou https://instagram.com/...';
      socialInput.required = true;
    }
    if (phoneInput) phoneInput.required = false;

    // Autopreencher nome simples para "Insta"
    if (contactNameInput) {
      if (!contactNameInput.value || contactNameInput.value === 'Face' || contactNameInput.value === 'WhatsApp' || contactNameInput.value === 'Telefone') {
        contactNameInput.value = 'Insta';
      }
    }
  } else if (type === 'facebook') {
    if (phoneGroup) phoneGroup.style.display = 'none';
    if (socialGroup) socialGroup.style.display = 'block';
    if (waCheckGroup) waCheckGroup.style.display = 'none';
    if (socialLabel) socialLabel.textContent = 'Página no Facebook (link ou perfil): *';
    if (socialInput) {
      socialInput.placeholder = 'https://facebook.com/nomedocdv ou nomedocdv';
      socialInput.required = true;
    }
    if (phoneInput) phoneInput.required = false;

    // Autopreencher nome simples para "Face"
    if (contactNameInput) {
      if (!contactNameInput.value || contactNameInput.value === 'Insta' || contactNameInput.value === 'WhatsApp' || contactNameInput.value === 'Telefone') {
        contactNameInput.value = 'Face';
      }
    }
  } else {
    // whatsapp ou phone
    if (socialGroup) socialGroup.style.display = 'none';
    if (phoneGroup) phoneGroup.style.display = 'block';
    if (socialInput) socialInput.required = false;
    if (phoneInput) phoneInput.required = true;

    // Limpa valor se era Insta ou Face ao retornar para telefone
    if (contactNameInput && (contactNameInput.value === 'Insta' || contactNameInput.value === 'Face')) {
      contactNameInput.value = '';
    }

    if (type === 'whatsapp') {
      if (waCheckGroup) {
        waCheckGroup.style.display = 'flex';
        const chk = document.getElementById('suggest-is-whatsapp');
        if (chk) chk.checked = true;
      }
    } else {
      if (waCheckGroup) {
        waCheckGroup.style.display = 'flex';
        const chk = document.getElementById('suggest-is-whatsapp');
        if (chk) chk.checked = false;
      }
    }
  }
}

function openSuggestModal(cdv) {
  const modal = document.getElementById('suggest-modal');
  const nameEl = document.getElementById('suggest-modal-target-name');
  const codeInput = document.getElementById('suggest-cdv-code');
  const contactNameInput = document.getElementById('suggest-contact-name');
  const phoneInput = document.getElementById('suggest-phone');
  const socialInput = document.getElementById('suggest-social-val');
  const typeSelect = document.getElementById('suggest-type');
  const errEl = document.getElementById('suggest-error');
  const succEl = document.getElementById('suggest-success');

  nameEl.textContent = `${cdv.nome} (${cdv.codigo}) • ${cdv.municipio || ''}`;
  codeInput.value = cdv.codigo;
  contactNameInput.value = '';
  if (phoneInput) phoneInput.value = '';
  if (socialInput) socialInput.value = '';
  if (typeSelect) {
    typeSelect.value = 'whatsapp';
    handleSuggestTypeChange('whatsapp');
  }
  errEl.style.display = 'none';
  succEl.style.display = 'none';

  modal.style.display = 'flex';
}

function closeSuggestModal() {
  const modal = document.getElementById('suggest-modal');
  if (modal) modal.style.display = 'none';
}

function closeModalOnBackdrop(e, modalId) {
  if (e.target && e.target.id === modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.style.display = 'none';
  }
}

async function submitSuggestion(event) {
  event.preventDefault();
  const code = document.getElementById('suggest-cdv-code').value.trim();
  const type = (document.getElementById('suggest-type')?.value || 'whatsapp').trim().toLowerCase();
  const name = document.getElementById('suggest-contact-name').value.trim();
  const phone = (document.getElementById('suggest-phone')?.value || '').trim();
  const socialVal = (document.getElementById('suggest-social-val')?.value || '').trim();
  const isWa = document.getElementById('suggest-is-whatsapp')?.checked ?? (type === 'whatsapp');
  const errEl = document.getElementById('suggest-error');
  const succEl = document.getElementById('suggest-success');
  const btnSubmit = document.getElementById('btn-submit-suggest');

  errEl.style.display = 'none';
  succEl.style.display = 'none';

  let cleanName = name;
  if (type === 'instagram' && (!cleanName || cleanName.toLowerCase() === 'instagram')) {
    cleanName = 'Insta';
  } else if (type === 'facebook' && (!cleanName || cleanName.toLowerCase() === 'facebook')) {
    cleanName = 'Face';
  }

  let payload = {
    cdv_codigo: code,
    tipo: type,
    nome_contato: cleanName,
    is_whatsapp: isWa
  };

  if (type === 'instagram' || type === 'facebook') {
    if (!socialVal) {
      errEl.textContent = `Informe o perfil ou link do ${type === 'instagram' ? 'Instagram' : 'Facebook'}.`;
      errEl.style.display = 'block';
      return;
    }
    payload.valor = socialVal;
  } else {
    let cleanDigits = phone.replace(/\D+/g, '');
    if (cleanDigits.startsWith('0') && cleanDigits.length > 2) {
      cleanDigits = cleanDigits.replace(/^0+/, '');
    }
    if (cleanDigits.length < 10 || cleanDigits.length > 11) {
      errEl.textContent = 'Informe um telefone brasileiro válido com DDD (10 ou 11 dígitos).';
      errEl.style.display = 'block';
      return;
    }
    payload.telefone = cleanDigits;
    payload.valor = cleanDigits;
  }

  btnSubmit.disabled = true;
  btnSubmit.textContent = 'Enviando...';

  try {
    const resp = await fetch('/api/suggestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await resp.json();

    if (resp.ok) {
      succEl.textContent = data.message || 'Sugestão enviada com sucesso! Passará por moderação.';
      succEl.style.display = 'block';
      showToast('Sugestão enviada com sucesso! 💡');
      setTimeout(() => {
        closeSuggestModal();
        btnSubmit.disabled = false;
        btnSubmit.textContent = 'Enviar Sugestão';
      }, 1800);
    } else {
      errEl.textContent = data.error || 'Erro ao enviar sugestão.';
      errEl.style.display = 'block';
      btnSubmit.disabled = false;
      btnSubmit.textContent = 'Enviar Sugestão';
    }
  } catch (err) {
    errEl.textContent = 'Erro de comunicação com o servidor.';
    errEl.style.display = 'block';
    btnSubmit.disabled = false;
    btnSubmit.textContent = 'Enviar Sugestão';
  }
}

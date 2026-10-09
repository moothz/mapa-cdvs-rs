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
let favoritesSet = new Set();
let seenSet = new Set();
let currentQuickFilter = 'all'; // 'all' | 'favorites' | 'unseen'

// Coordenadas Centrais e Limites do Rio Grande do Sul
const RS_CENTER = [-29.8, -53.2];
const RS_INITIAL_ZOOM = 7;
const RS_BOUNDS = [
  [-34.2, -58.2], // Sudoeste (margem sul/oeste do RS)
  [-26.7, -49.2]  // Nordeste (margem norte/leste do RS)
];

document.addEventListener('DOMContentLoaded', () => {
  loadStorageData();
  initMap();
  loadData();
  setupEventListeners();
  setupPhoneMask();
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
    minZoom: 7,
    maxBounds: RS_BOUNDS,
    maxBoundsViscosity: 1.0,
    zoomControl: true,
  });

  // Camada OpenStreetMap
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | Dados: Detran-RS',
    minZoom: 7,
    maxZoom: 19,
    bounds: RS_BOUNDS,
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
   Datalist e Picker de Cidades do RS
   ========================================================================== */
function populateCitiesDatalist() {
  const datalist = document.getElementById('cities-datalist');
  const selectPicker = document.getElementById('city-picker-select');
  if (datalist) datalist.innerHTML = '';
  if (selectPicker) {
    selectPicker.innerHTML = '<option value="">🗺️ Ou escolha na lista (497 cidades)...</option>';
  }

  const sortedCities = Object.values(citiesRs).map(c => c.nome).sort((a, b) => a.localeCompare(b, 'pt-BR'));

  sortedCities.forEach(city => {
    if (datalist) {
      const option = document.createElement('option');
      option.value = city;
      datalist.appendChild(option);
    }
    if (selectPicker) {
      const option = document.createElement('option');
      option.value = city;
      option.textContent = city;
      selectPicker.appendChild(option);
    }
  });
}

/* ==========================================================================
   Event Listeners
   ========================================================================== */
function setupEventListeners() {
  const cityInput = document.getElementById('city-input');
  const cityPickerSelect = document.getElementById('city-picker-select');
  const btnClearCity = document.getElementById('btn-clear-city');
  const textSearch = document.getElementById('text-search');

  if (textSearch) {
    const debouncedFilter = debounce(() => {
      applyFilters();
    }, 250);
    textSearch.addEventListener('input', debouncedFilter);
  }

  if (cityPickerSelect) {
    cityPickerSelect.addEventListener('change', (e) => {
      const val = e.target.value.trim().toUpperCase();
      if (!val) {
        clearLocationFilter();
        return;
      }
      if (cityInput) cityInput.value = e.target.value;
      if (btnClearCity) btnClearCity.style.display = 'block';

      const matchedCity = Object.values(citiesRs).find(c => c.nome.toUpperCase() === val);
      if (matchedCity) {
        setUserLocation(matchedCity.lat, matchedCity.lng, `${matchedCity.nome}/RS`);
      }
    });
  }

  if (cityInput) {
    const handleCityInput = (val) => {
      if (val.length > 0) {
        if (btnClearCity) btnClearCity.style.display = 'block';
      } else {
        if (btnClearCity) btnClearCity.style.display = 'none';
        if (cityPickerSelect) cityPickerSelect.value = '';
      }

      const matchedCity = Object.values(citiesRs).find(c => c.nome.toUpperCase() === val);
      if (matchedCity) {
        if (cityPickerSelect) cityPickerSelect.value = matchedCity.nome;
        setUserLocation(matchedCity.lat, matchedCity.lng, `${matchedCity.nome}/RS`);
      }
    };

    cityInput.addEventListener('input', (e) => {
      handleCityInput(e.target.value.trim().toUpperCase());
    });

    cityInput.addEventListener('change', (e) => {
      handleCityInput(e.target.value.trim().toUpperCase());
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

function setupPhoneMask() {
  const phoneInput = document.getElementById('suggest-phone');
  if (!phoneInput) return;

  phoneInput.addEventListener('input', (e) => {
    let val = e.target.value.replace(/\D/g, '');
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
}

/* ==========================================================================
   Geolocalização do Usuário (GPS e Cidade)
   ========================================================================== */
function getUserGPSLocation() {
  const btn = document.getElementById('btn-gps');
  if (!navigator.geolocation) {
    alert('Geolocalização não é suportada pelo seu navegador.');
    return;
  }

  btn.classList.add('loading');
  btn.querySelector('span:last-child').textContent = 'Obtendo localização...';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.classList.remove('loading');
      btn.querySelector('span:last-child').textContent = 'Usar minha localização (GPS)';

      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;

      setUserLocation(lat, lng, 'Sua localização atual (GPS)');
    },
    (err) => {
      btn.classList.remove('loading');
      btn.querySelector('span:last-child').textContent = 'Usar minha localização (GPS)';
      console.warn('Erro ao obter GPS:', err);
      alert('Não foi possível obter sua localização. Por favor, selecione sua cidade no campo abaixo.');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

function setUserLocation(lat, lng, label) {
  userLocation = { lat, lng, label };

  const banner = document.getElementById('active-location-banner');
  const bannerLabel = document.getElementById('active-location-label');
  if (banner) banner.style.display = 'flex';
  if (bannerLabel) bannerLabel.textContent = label;

  if (userMarker) {
    map.removeLayer(userMarker);
  }

  const userIcon = L.divIcon({
    className: 'user-gps-marker',
    html: `
      <div style="background-color: #047857; width: 18px; height: 18px; border-radius: 50%; border: 3px solid #FFF; box-shadow: 0 0 10px rgba(4,120,87,0.7); position: relative;">
        <div style="position: absolute; top: -6px; left: -6px; width: 24px; height: 24px; border-radius: 50%; background-color: rgba(4,120,87,0.25); animation: pulse-gps 1.5s infinite;"></div>
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
}

function clearLocationFilter() {
  userLocation = null;
  const cityInput = document.getElementById('city-input');
  if (cityInput) cityInput.value = '';
  const selectPicker = document.getElementById('city-picker-select');
  if (selectPicker) selectPicker.value = '';
  const btnClearCity = document.getElementById('btn-clear-city');
  if (btnClearCity) btnClearCity.style.display = 'none';
  const banner = document.getElementById('active-location-banner');
  if (banner) banner.style.display = 'none';
  const radiusSelect = document.getElementById('radius-select');
  if (radiusSelect) radiusSelect.value = 'all';

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
  const radiusSelect = document.getElementById('radius-select');
  const radiusVal = radiusSelect ? radiusSelect.value : 'all';
  const radiusKm = radiusVal === 'all' ? Infinity : parseFloat(radiusVal);

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

    // 2. Filtro de raio
    if (userLocation && cdv.distance !== null && cdv.distance > radiusKm) {
      return false;
    }

    // 3. Filtro textual
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

/* ==========================================================================
   Criação de Card de CDV
   ========================================================================== */
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
    ? `<button type="button" class="btn-action btn-whatsapp" onclick="handleContactClick('whatsapp', '${escapeHtml(cdv.whatsapp || '')}', '${escapeHtml(cdv.nome)}', '${safeWaUrl}')" title="Opções de WhatsApp">💬 WhatsApp</button>`
    : '';

  const phoneClean = (cdv.telefone || '').replace(/\D+/g, '');
  const phoneBtn = phoneClean
    ? `<button type="button" class="btn-action btn-phone" onclick="handleContactClick('phone', '${escapeHtml(cdv.telefone)}', '${escapeHtml(cdv.nome)}', 'tel:${phoneClean}')" title="Opções de Telefone">📞 ${escapeHtml(cdv.telefone)}</button>`
    : '';

  // Link de rota prioritário do Detran
  const routeUrl = getRouteUrl(cdv);
  const routeBtn = routeUrl && routeUrl !== '#'
    ? `<a href="${routeUrl}" target="_blank" rel="noopener noreferrer" class="btn-action btn-route" title="Ver rota ou localização no Google Maps">🗺️ Como Chegar</a>`
    : '';

  // Botão Salvar Contato (.vcf)
  const vcfBtn = `<button type="button" class="btn-action btn-vcf" onclick="downloadVCardFromCard('${escapeHtml(cdv.codigo)}')" title="Baixar contato (.vcf) para adicionar à sua agenda">📇 Salvar Contato</button>`;

  // Contatos Extras Aprovados (se houver)
  let extraContactsHtml = '';
  if (Array.isArray(cdv.contatos_extras) && cdv.contatos_extras.length > 0) {
    const extraButtons = cdv.contatos_extras.map(extra => {
      const type = extra.whatsapp ? 'whatsapp' : 'phone';
      const icon = extra.whatsapp ? '💬' : '📞';
      const url = extra.whatsapp_url || `tel:${(extra.telefone || '').replace(/\D+/g, '')}`;
      return `
        <button type="button" class="btn-extra-contact" onclick="handleContactClick('${type}', '${escapeHtml(extra.telefone_formatado || extra.telefone)}', '${escapeHtml(cdv.nome)} (${escapeHtml(extra.nome)})', '${url}')" title="Contato extra: ${escapeHtml(extra.nome)}">
          ${icon} ${escapeHtml(extra.nome)}: ${escapeHtml(extra.telefone_formatado || extra.telefone)}
        </button>
      `;
    }).join('');

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
        <button type="button" class="btn-icon-toggle btn-seen-toggle" onclick="toggleSeen('${escapeHtml(cdv.codigo)}')" title="${seen ? 'Marcar como não visto' : 'Marcar como visto'}">
          ${seen ? '👁️' : '👁️‍🗨️'}
        </button>
        <button type="button" class="btn-icon-toggle btn-fav-toggle ${favorite ? 'active' : ''}" onclick="toggleFavorite('${escapeHtml(cdv.codigo)}')" title="${favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}">
          ${favorite ? '❤️' : '🤍'}
        </button>
      </div>
    </div>
    <div class="card-badges">
      <span class="badge-code">${escapeHtml(cdv.codigo)}</span>
      ${distanceBadge}
      ${seen ? '<span class="badge-code" style="background:#E2E8F0; color:#475569;">Visto</span>' : ''}
    </div>
    <div class="card-address">
      <div>${escapeHtml(cdv.endereco || 'Endereço não informado')}${cdv.complemento ? ` (${escapeHtml(cdv.complemento)})` : ''}</div>
      <div>${escapeHtml(cdv.bairro ? `${cdv.bairro} • ` : '')}<span class="card-city">${escapeHtml(cdv.municipio || '')}</span> • CEP: ${escapeHtml(cdv.cep || '')}</div>
    </div>
    ${extraContactsHtml}
    <div class="card-actions">
      ${whatsappBtn}
      ${phoneBtn}
      ${routeBtn}
      ${vcfBtn}
    </div>
    <div>
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
      iconSize: [32, 32],
      iconAnchor: [16, 32],
      popupAnchor: [0, -30]
    });

    const marker = L.marker([cdv.lat, cdv.lng], {
      icon: pinIcon,
      zIndexOffset: favorite ? 500 : 0
    });

    const distanceText = cdv.distance !== null
      ? `<div class="popup-distance">📍 Aprox. ${cdv.distance < 10 ? cdv.distance.toFixed(1) : Math.round(cdv.distance)} km de você</div>`
      : '';

    const safeWaUrl = sanitizeUrl(cdv.whatsapp_url);
    const whatsappBtn = (safeWaUrl && safeWaUrl !== '#') || cdv.whatsapp
      ? `<button type="button" class="btn-action btn-whatsapp" style="font-size:0.75rem;" onclick="handleContactClick('whatsapp', '${escapeHtml(cdv.whatsapp || '')}', '${escapeHtml(cdv.nome)}', '${safeWaUrl}')">💬 WhatsApp</button>`
      : '';

    const phoneClean = (cdv.telefone || '').replace(/\D+/g, '');
    const phoneBtn = phoneClean
      ? `<button type="button" class="btn-action btn-phone" style="font-size:0.75rem;" onclick="handleContactClick('phone', '${escapeHtml(cdv.telefone)}', '${escapeHtml(cdv.nome)}', 'tel:${phoneClean}')">📞 ${escapeHtml(cdv.telefone)}</button>`
      : '';

    const routeUrl = getRouteUrl(cdv);
    const routeBtn = routeUrl && routeUrl !== '#'
      ? `<a href="${routeUrl}" target="_blank" rel="noopener noreferrer" class="btn-action btn-route" style="font-size:0.75rem;">🗺️ Rota</a>`
      : '';

    const vcfBtn = `<button type="button" class="btn-action btn-vcf" style="font-size:0.75rem;" onclick="downloadVCardFromCard('${escapeHtml(cdv.codigo)}')">📇 Salvar</button>`;

    const popupContent = `
      <div class="popup-card">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 6px;">
          <h4 class="popup-title">${escapeHtml(cdv.nome)}</h4>
          <div style="display:flex; gap:2px;">
            <button type="button" class="btn-icon-toggle" onclick="toggleSeen('${escapeHtml(cdv.codigo)}')" title="${seen ? 'Marcar como não visto' : 'Marcar como visto'}">${seen ? '👁️' : '👁️‍🗨️'}</button>
            <button type="button" class="btn-icon-toggle" onclick="toggleFavorite('${escapeHtml(cdv.codigo)}')" title="${favorite ? 'Remover dos favoritos' : 'Favoritar'}">${favorite ? '❤️' : '🤍'}</button>
          </div>
        </div>
        <div class="popup-code">${escapeHtml(cdv.codigo)}</div>
        ${distanceText}
        <div class="popup-address">
          <strong>${escapeHtml(cdv.endereco || '')}</strong><br>
          ${escapeHtml(cdv.bairro ? `${cdv.bairro} • ` : '')}${escapeHtml(cdv.municipio || '')}<br>
          CEP: ${escapeHtml(cdv.cep || '')}
        </div>
        <div class="popup-actions">
          ${whatsappBtn}
          ${phoneBtn}
          ${routeBtn}
          ${vcfBtn}
        </div>
        <div style="margin-top:6px; text-align:center;">
          <button type="button" class="btn-suggest" style="font-size:0.72rem;" onclick="openSuggestModalFromCard('${escapeHtml(cdv.codigo)}')">
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

function handleContactClick(tipo, numeroRaw, nomeCdv, openUrl) {
  const modal = document.getElementById('contact-modal');
  const titleEl = document.getElementById('contact-modal-title');
  const nameEl = document.getElementById('contact-modal-target-name');
  const numEl = document.getElementById('contact-modal-number');
  const btnOpen = document.getElementById('btn-contact-open');
  const btnCopy = document.getElementById('btn-contact-copy');

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
    btnOpen.innerHTML = '🚀 Abrir no WhatsApp';
  } else {
    titleEl.textContent = '📞 Contato Telefônico';
    btnOpen.innerHTML = '📞 Ligar Agora';
  }

  nameEl.textContent = nomeCdv;
  numEl.textContent = formatted || 'Número não disponível';

  btnOpen.onclick = () => {
    if (currentContactAction.openUrl && currentContactAction.openUrl !== '#') {
      if (currentContactAction.openUrl.startsWith('tel:')) {
        window.location.href = currentContactAction.openUrl;
      } else {
        window.open(currentContactAction.openUrl, '_blank', 'noopener,noreferrer');
      }
    } else if (cleanDigits) {
      if (tipo === 'whatsapp') {
        window.open(`https://api.whatsapp.com/send?phone=55${cleanDigits}`, '_blank', 'noopener,noreferrer');
      } else {
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

function openSuggestModal(cdv) {
  const modal = document.getElementById('suggest-modal');
  const nameEl = document.getElementById('suggest-modal-target-name');
  const codeInput = document.getElementById('suggest-cdv-code');
  const contactNameInput = document.getElementById('suggest-contact-name');
  const phoneInput = document.getElementById('suggest-phone');
  const errEl = document.getElementById('suggest-error');
  const succEl = document.getElementById('suggest-success');

  nameEl.textContent = `${cdv.nome} (${cdv.codigo}) • ${cdv.municipio || ''}`;
  codeInput.value = cdv.codigo;
  contactNameInput.value = '';
  phoneInput.value = '';
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
  const name = document.getElementById('suggest-contact-name').value.trim();
  const phone = document.getElementById('suggest-phone').value.trim();
  const isWa = document.getElementById('suggest-is-whatsapp').checked;
  const errEl = document.getElementById('suggest-error');
  const succEl = document.getElementById('suggest-success');
  const btnSubmit = document.getElementById('btn-submit-suggest');

  errEl.style.display = 'none';
  succEl.style.display = 'none';

  const cleanDigits = phone.replace(/\D+/g, '');
  if (cleanDigits.length < 10 || cleanDigits.length > 11) {
    errEl.textContent = 'Informe um telefone brasileiro válido com DDD (10 ou 11 dígitos).';
    errEl.style.display = 'block';
    return;
  }

  btnSubmit.disabled = true;
  btnSubmit.textContent = 'Enviando...';

  try {
    const resp = await fetch('/api/suggestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cdv_codigo: code,
        nome_contato: name,
        telefone: phone,
        is_whatsapp: isWa
      })
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

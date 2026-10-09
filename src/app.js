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

// Coordenadas Centrais do Rio Grande do Sul
const RS_CENTER = [-29.8, -53.2];
const RS_INITIAL_ZOOM = 7;

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadData();
  setupEventListeners();
});

/* ==========================================================================
   Inicialização do Mapa (Leaflet + MarkerCluster)
   ========================================================================== */
function initMap() {
  map = L.map('map', {
    center: RS_CENTER,
    zoom: RS_INITIAL_ZOOM,
    zoomControl: true,
  });

  // Camada OpenStreetMap
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | Dados: Detran-RS',
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
        document.getElementById('total-cdvs-count').textContent = `${allCdvs.length} CDVs Credenciados (${dateStr})`;
      } else {
        document.getElementById('total-cdvs-count').textContent = `${allCdvs.length} CDVs Credenciados`;
      }
    } catch (e) {
      document.getElementById('total-cdvs-count').textContent = `${allCdvs.length} CDVs Credenciados`;
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
   Datalist de Cidades do RS
   ========================================================================== */
function populateCitiesDatalist() {
  const datalist = document.getElementById('cities-datalist');
  datalist.innerHTML = '';
  
  const sortedCities = Object.values(citiesRs).map(c => c.nome).sort((a, b) => a.localeCompare(b));
  
  sortedCities.forEach(city => {
    const option = document.createElement('option');
    option.value = city;
    datalist.appendChild(option);
  });
}

/* ==========================================================================
   Event Listeners
   ========================================================================== */
function setupEventListeners() {
  const cityInput = document.getElementById('city-input');
  const btnClearCity = document.getElementById('btn-clear-city');

  cityInput.addEventListener('input', (e) => {
    const val = e.target.value.trim().toUpperCase();
    if (val.length > 0) {
      btnClearCity.style.display = 'block';
    } else {
      btnClearCity.style.display = 'none';
    }

    // Procura cidade correspondente exata
    const matchedCity = Object.values(citiesRs).find(c => c.nome.toUpperCase() === val);
    if (matchedCity) {
      setUserLocation(matchedCity.lat, matchedCity.lng, `${matchedCity.nome}/RS`);
    }
  });

  cityInput.addEventListener('change', (e) => {
    const val = e.target.value.trim().toUpperCase();
    const matchedCity = Object.values(citiesRs).find(c => c.nome.toUpperCase() === val);
    if (matchedCity) {
      setUserLocation(matchedCity.lat, matchedCity.lng, `${matchedCity.nome}/RS`);
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

  // Atualiza banner de localização
  const banner = document.getElementById('active-location-banner');
  const bannerLabel = document.getElementById('active-location-label');
  banner.style.display = 'flex';
  bannerLabel.textContent = label;

  // Atualiza marcador no mapa
  if (userMarker) {
    map.removeLayer(userMarker);
  }

  const userIcon = L.divIcon({
    className: 'user-gps-marker',
    html: `
      <div style="background-color: #007A33; width: 18px; height: 18px; border-radius: 50%; border: 3px solid #FFF; box-shadow: 0 0 10px rgba(0,122,51,0.6); position: relative;">
        <div style="position: absolute; top: -6px; left: -6px; width: 24px; height: 24px; border-radius: 50%; background-color: rgba(0,122,51,0.25); animation: pulse-gps 1.5s infinite;"></div>
      </div>
    `,
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });

  userMarker = L.marker([lat, lng], { icon: userIcon, zIndexOffset: 1000 })
    .addTo(map)
    .bindPopup(`<strong>📍 ${label}</strong><br><span style="font-size:0.75rem; color:#666;">Ponto de referência para distâncias</span>`);

  map.flyTo([lat, lng], 11, { duration: 1.2 });

  // Recalcula e reordena
  applyFilters();
}

function clearLocationFilter() {
  userLocation = null;
  document.getElementById('city-input').value = '';
  document.getElementById('btn-clear-city').style.display = 'none';
  document.getElementById('active-location-banner').style.display = 'none';
  document.getElementById('radius-select').value = 'all';

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
  const R = 6371; // Raio da Terra em km
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
   Filtros, Ordenação e Atualização
   ========================================================================== */
function applyFilters() {
  const searchTerm = document.getElementById('text-search').value.trim().toLowerCase();
  const radiusVal = document.getElementById('radius-select').value;
  const radiusKm = radiusVal === 'all' ? Infinity : parseFloat(radiusVal);

  // Calcula distâncias e filtra
  filteredCdvs = allCdvs.map(cdv => {
    let distance = null;
    if (userLocation && cdv.lat && cdv.lng) {
      distance = calculateDistance(userLocation.lat, userLocation.lng, cdv.lat, cdv.lng);
    }
    return { ...cdv, distance };
  }).filter(cdv => {
    // 1. Filtro de raio
    if (userLocation && cdv.distance !== null && cdv.distance > radiusKm) {
      return false;
    }

    // 2. Filtro textual
    if (searchTerm) {
      const matchName = (cdv.nome || '').toLowerCase().includes(searchTerm);
      const matchCode = (cdv.codigo || '').toLowerCase().includes(searchTerm);
      const matchCity = (cdv.municipio || '').toLowerCase().includes(searchTerm);
      const matchBairro = (cdv.bairro || '').toLowerCase().includes(searchTerm);
      const matchEnd = (cdv.endereco || '').toLowerCase().includes(searchTerm);
      if (!matchName && !matchCode && !matchCity && !matchBairro && !matchEnd) {
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
    document.getElementById('sort-info').textContent = 'Mais próximos primeiro 📍';
  } else {
    filteredCdvs.sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
    document.getElementById('sort-info').textContent = 'Ordem alfabética';
  }

  // Atualiza contadores
  const countText = `Exibindo ${filteredCdvs.length} de ${allCdvs.length} CDVs`;
  document.getElementById('results-count').textContent = countText;
  document.getElementById('mobile-count').textContent = filteredCdvs.length;

  renderList();
  renderMarkers();
}

/* ==========================================================================
   Renderização dos Cards na Lista
   ========================================================================== */
function renderList() {
  const container = document.getElementById('cdv-list');
  container.innerHTML = '';

  if (filteredCdvs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>🔍 Nenhum CDV encontrado com os filtros atuais.</p>
        <p style="font-size: 0.8rem; margin-top: 6px;">Tente aumentar o raio de distância ou limpar a busca textual.</p>
      </div>
    `;
    return;
  }

  const fragment = document.createDocumentFragment();

  filteredCdvs.forEach(cdv => {
    const card = document.createElement('article');
    card.className = 'cdv-card';
    card.id = `card-${cdv.codigo}`;

    const distanceBadge = cdv.distance !== null
      ? `<span class="badge-distance" title="Distância em linha reta">📍 ${cdv.distance < 10 ? cdv.distance.toFixed(1) : Math.round(cdv.distance)} km</span>`
      : '';

    const whatsappBtn = cdv.whatsapp_url
      ? `<a href="${cdv.whatsapp_url}" target="_blank" rel="noopener noreferrer" class="btn-action btn-whatsapp" title="Abrir conversa no WhatsApp">💬 WhatsApp</a>`
      : '';

    const phoneClean = (cdv.telefone || '').replace(/\D+/g, '');
    const phoneBtn = phoneClean
      ? `<a href="tel:${phoneClean}" class="btn-action btn-phone" title="Ligar para o CDV">📞 ${cdv.telefone}</a>`
      : '';

    // URL de rota no Google Maps
    const routeUrl = (cdv.lat && cdv.lng)
      ? `https://www.google.com/maps/dir/?api=1&destination=${cdv.lat},${cdv.lng}`
      : (cdv.maps_url || '#');

    const routeBtn = `<a href="${routeUrl}" target="_blank" rel="noopener noreferrer" class="btn-action btn-route" title="Traçar rota no Google Maps">🗺️ Como Chegar</a>`;

    card.innerHTML = `
      <div class="card-header">
        <h3 class="card-title">${escapeHtml(cdv.nome)}</h3>
        <div class="card-badges">
          <span class="badge-code">${escapeHtml(cdv.codigo)}</span>
          ${distanceBadge}
        </div>
      </div>
      <div class="card-address">
        <div>${escapeHtml(cdv.endereco || 'Endereço não informado')}${cdv.complemento ? ` (${escapeHtml(cdv.complemento)})` : ''}</div>
        <div>${escapeHtml(cdv.bairro ? `${cdv.bairro} • ` : '')}<span class="card-city">${escapeHtml(cdv.municipio || '')}</span> • CEP: ${escapeHtml(cdv.cep || '')}</div>
      </div>
      <div class="card-actions">
        ${whatsappBtn}
        ${phoneBtn}
        ${routeBtn}
      </div>
    `;

    // Clicar no card move o mapa até o local
    card.addEventListener('click', (e) => {
      // Evita disparar se clicou diretamente em um link de ação
      if (e.target.closest('a')) return;
      focusCdvOnMap(cdv);
    });

    fragment.appendChild(card);
  });

  container.appendChild(fragment);
}

/* ==========================================================================
   Renderização dos Pins no Mapa (Leaflet)
   ========================================================================== */
function renderMarkers() {
  markerCluster.clearLayers();
  markersMap.clear();

  filteredCdvs.forEach(cdv => {
    if (!cdv.lat || !cdv.lng) return;

    // Ícone estilizado
    const pinIcon = L.divIcon({
      className: 'custom-pin-wrapper',
      html: `<div class="custom-pin"><span>🔧</span></div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 32],
      popupAnchor: [0, -30]
    });

    const marker = L.marker([cdv.lat, cdv.lng], { icon: pinIcon });

    const distanceText = cdv.distance !== null
      ? `<div style="color:#007A33; font-weight:700; font-size:0.8rem; margin-bottom:4px;">📍 Aprox. ${cdv.distance < 10 ? cdv.distance.toFixed(1) : Math.round(cdv.distance)} km de você</div>`
      : '';

    const whatsappBtn = cdv.whatsapp_url
      ? `<a href="${cdv.whatsapp_url}" target="_blank" rel="noopener noreferrer" class="btn-action btn-whatsapp" style="font-size:0.75rem;">💬 WhatsApp</a>`
      : '';

    const routeUrl = `https://www.google.com/maps/dir/?api=1&destination=${cdv.lat},${cdv.lng}`;
    const routeBtn = `<a href="${routeUrl}" target="_blank" rel="noopener noreferrer" class="btn-action btn-route" style="font-size:0.75rem;">🗺️ Rota</a>`;

    const popupContent = `
      <div class="popup-card">
        <h4 class="popup-title">${escapeHtml(cdv.nome)}</h4>
        <div class="popup-code">${escapeHtml(cdv.codigo)}</div>
        ${distanceText}
        <div class="popup-address">
          <strong>${escapeHtml(cdv.endereco || '')}</strong><br>
          ${escapeHtml(cdv.bairro || '')} • ${escapeHtml(cdv.municipio || '')}<br>
          CEP: ${escapeHtml(cdv.cep || '')}
        </div>
        <div class="popup-actions">
          ${whatsappBtn}
          ${routeBtn}
        </div>
      </div>
    `;

    marker.bindPopup(popupContent);

    marker.on('click', () => {
      highlightCardInList(cdv.codigo);
    });

    markerCluster.addLayer(marker);
    markersMap.set(cdv.codigo, marker);
  });
}

/* ==========================================================================
   Interatividade Bidirecional Mapa <-> Lista
   ========================================================================== */
function focusCdvOnMap(cdv) {
  if (!cdv.lat || !cdv.lng) return;

  // Se estiver em mobile, muda para a visualização do mapa
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

/* Utilitário de escape HTML */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

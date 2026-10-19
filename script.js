'use strict';
// Change only this base URL when you export another Teachable Machine image model.
const MODEL_URL = 'https://teachablemachine.withgoogle.com/models/4IJB2H1WW/';
const THRESHOLD = 0.80;
const CLASSES = ['Paper', 'Plastic', 'Cardboard'];
// Demonstration only. Replace accepts arrays after confirming school collection rules.
const BIN_RULES = {
  Paper: {name: 'Paper & Mixed Fiber', accepts: ['Paper']},
  Plastic: {name: 'Plastics & Containers', accepts: ['Plastic']},
  Cardboard: {name: 'Cardboard & Corrugated', accepts: ['Cardboard']}
};
const ADVICE = {
  Paper: 'Keep paper clean and dry. Check the school’s accepted paper types.',
  Plastic: 'Empty and rinse containers. Check which plastic types the school accepts; this model cannot identify resin codes.',
  Cardboard: 'Flatten the box, remove packing inserts, and keep it dry. Ask staff about food-soiled material.'
};
const STORAGE_KEY = 'ecosort-pctvs-4IJB2H1WW-v1';
const $ = id => document.getElementById(id);
let model = null, modelPromise = null, stream = null, generation = 0;
let predicting = false, facing = 'environment', selectedBin = null, latest = null;
let itemSaved = false, activeInput = null, previewURL = null, scans = [];
let storageAvailable = true;
const crop = document.createElement('canvas');
crop.width = crop.height = 224;
function canonical(label) {
  return CLASSES.find(c => c.toLowerCase() === String(label).trim().toLowerCase()) || null;
}
function evaluatePrediction(prediction, bin) {
  if (!prediction) return {state: 'neutral', title: 'Ready for your first scan', detail: 'Choose a bin and analyze one item. No prediction is available yet.'};
  if (!Number.isFinite(prediction.probability) || prediction.probability < THRESHOLD)
    return {state: 'uncertain', title: 'Uncertain — please scan again', detail: 'Show one item clearly in good light. The best match is below 80% confidence.'};
  if (!prediction.material) return {state: 'uncertain', title: 'Unsupported model class', detail: 'This result does not match Paper, Plastic, or Cardboard. Check the model class names.'};
  if (!BIN_RULES[bin]) return {state: 'neutral', title: 'Which bin are you using?', detail: 'Choose a target bin above to compare with the predicted ' + prediction.material + '.'};
  const match = BIN_RULES[bin].accepts.includes(prediction.material);
  const suitable = Object.values(BIN_RULES).find(b => b.accepts.includes(prediction.material));
  return match
    ? {state: 'match', title: 'MATCH! Material fits the selected demo bin.', detail: ADVICE[prediction.material]}
    : {state: 'wrong', title: 'WRONG BIN for the predicted material.', detail: prediction.material + ' detected. Please use ' + (suitable ? suitable.name : 'a bin confirmed by staff') + ' under these demonstration rules. ' + ADVICE[prediction.material]};
}
function updateOutcome() {
  const result = evaluatePrediction(latest, selectedBin);
  $('outcome').className = 'outcome ' + result.state;
  $('outcomeTitle').textContent = result.title;
  $('outcomeAdvice').textContent = result.detail;
  $('saveScan').disabled = itemSaved || !latest || !latest.material || latest.probability < THRESHOLD || !BIN_RULES[selectedBin];
  renderReport();
}
function setStatus(message) { $('status').textContent = message; }
function resetResults() {
  latest = null;
  $('topMaterial').textContent = '—'; $('topConfidence').textContent = '—';
  $('targetHud').hidden = true;
  document.querySelectorAll('#probabilities progress').forEach(p => p.value = 0);
  document.querySelectorAll('#probabilities .percentage').forEach(p => p.textContent = '—');
  updateOutcome();
}
function drawProbabilities(values) {
  $('probabilities').replaceChildren();
  CLASSES.forEach(material => {
    const prediction = values.find(v => v.material === material);
    const value = prediction ? prediction.probability : 0;
    const row = document.createElement('div'); row.className = 'probability';
    const labels = document.createElement('div');
    const name = document.createElement('span'); name.textContent = material;
    const percent = document.createElement('span'); percent.className = 'percentage'; percent.textContent = (value * 100).toFixed(1) + '%';
    const progress = document.createElement('progress'); progress.max = 1; progress.value = value;
    progress.setAttribute('aria-label', material + ' confidence');
    labels.append(name, percent); row.append(labels, progress); $('probabilities').append(row);
  });
}
function displayPredictions(predictions) {
  const values = predictions.map(p => ({label: String(p.className), material: canonical(p.className), probability: Number(p.probability)}));
  if (!values.length || values.some(p => !Number.isFinite(p.probability) || p.probability < 0 || p.probability > 1)) throw new Error('The model returned invalid prediction values.');
  values.sort((a, b) => b.probability - a.probability);
  latest = values[0];
  const text = latest.material || latest.label;
  $('topMaterial').textContent = text;
  $('topConfidence').textContent = (latest.probability * 100).toFixed(1) + '%';
  $('hudMaterial').textContent = text;
  $('hudConfidence').textContent = (latest.probability * 100).toFixed(1) + '% confidence';
  $('targetHud').hidden = false;
  drawProbabilities(values); updateOutcome();
}
async function ensureModel() {
  if (model) return model;
  if (!modelPromise) {
    modelPromise = (async () => {
      if (!window.tf || !window.tmImage) throw new Error('AI libraries did not load. Check internet access to cdn.jsdelivr.net, then reload the page.');
      $('modelState').textContent = 'Loading model…';
      await tf.ready();
      let timer;
      try {
        const loaded = await Promise.race([
          tmImage.load(MODEL_URL + 'model.json', MODEL_URL + 'metadata.json'),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Model loading timed out. Check internet access to the model host and try again.')), 60000); })
        ]);
        const labels = loaded.getClassLabels();
        if (labels.length !== 3 || new Set(labels.map(canonical)).size !== 3 || labels.some(label => !canonical(label))) {
          if (loaded.model && loaded.model.dispose) loaded.model.dispose();
          throw new Error('Model labels must be Paper, Plastic, and Cardboard (case-insensitive). Found: ' + labels.join(', '));
        }
        model = loaded; $('modelState').textContent = 'Model ready'; return model;
      } finally { clearTimeout(timer); }
    })().catch(error => { modelPromise = null; $('modelState').textContent = 'Model load failed'; throw error; });
  }
  return modelPromise;
}
function cancelInput(clear = true) {
  generation++;
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null; $('video').srcObject = null; $('video').hidden = true;
  $('stopCamera').disabled = true; $('startCamera').disabled = false;
  $('snapshot').disabled = true; $('flipLens').disabled = true;
  activeInput = null;
  if (clear) resetResults();
}
function beginNewItem() {
  itemSaved = false; reportPhoto = null; reportSource = '';
  document.querySelectorAll('.checklist input').forEach(input => input.checked = false);
  $('saveStatus').textContent = 'New item ready. Check the prediction, then save once.';
  resetResults();
}
function setMode(mode) {
  const upload = mode === 'upload';
  $('cameraMode').classList.toggle('active', !upload); $('uploadMode').classList.toggle('active', upload);
  $('cameraMode').setAttribute('aria-pressed', String(!upload)); $('uploadMode').setAttribute('aria-pressed', String(upload));
  $('dropHint').hidden = !upload;
}
async function classify(source, token) {
  if (predicting || token !== generation) return;
  predicting = true;
  try {
    const m = await ensureModel();
    if (token !== generation) return;
    const width = source.videoWidth || source.naturalWidth || source.width;
    const height = source.videoHeight || source.naturalHeight || source.height;
    if (!width || !height) return;
    const side = Math.min(width, height);
    crop.getContext('2d').drawImage(source, (width - side) / 2, (height - side) / 2, side, side, 0, 0, 224, 224);
    const values = await m.predict(crop);
    if (token !== generation) return;
    displayPredictions(values);
  } finally { predicting = false; }
}
async function classifyStill(source, token) {
  while (predicting && token === generation) await new Promise(resolve => setTimeout(resolve, 30));
  if (token === generation) await classify(source, token);
}
async function predictionLoop(token) {
  while (stream && token === generation) {
    try { if ($('video').readyState >= 2) await classify($('video'), token); }
    catch (error) {
      if (token === generation) { cancelInput(); setStatus('Prediction failed: ' + error.message); $('feedStatus').textContent = 'CAMERA STOPPED'; }
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
async function startCamera() {
  cancelInput(); beginNewItem(); setMode('camera');
  const token = generation;
  $('startCamera').disabled = true; $('stopCamera').disabled = false;
  setStatus('Loading the model and requesting camera access…');
  try {
    await ensureModel();
    if (token !== generation) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Camera access needs a supported browser with HTTPS or localhost. You can use image upload instead.');
    const acquired = await navigator.mediaDevices.getUserMedia({video: {facingMode: {ideal: facing}}, audio: false});
    if (token !== generation) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired; activeInput = 'camera';
    $('video').srcObject = acquired; $('video').hidden = false; $('uploadPreview').hidden = true; $('designPreview').hidden = true;
    $('inputMessage').hidden = true; $('dropHint').hidden = true;
    await $('video').play();
    if (token !== generation) return;
    $('snapshot').disabled = false; $('flipLens').disabled = false;
    $('feedStatus').textContent = 'LIVE CAMERA · MODEL ACTIVE'; $('inputKind').textContent = 'LIVE INPUT';
    setStatus('Camera ready. Hold one item in view. Predictions update automatically.');
    predictionLoop(token);
  } catch (error) {
    if (token === generation) {
      cancelInput(); setStatus('Could not start: ' + error.message);
      $('inputMessage').hidden = false; $('inputMessage').textContent = 'Camera unavailable. Try Upload Image.';
      $('feedStatus').textContent = 'CAMERA OFF';
    }
  }
}
async function useImage(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { setStatus('Please select a PNG, JPEG, or other supported image file.'); return; }
  cancelInput(); beginNewItem(); setMode('upload'); $('dropHint').hidden = true;
  const token = generation;
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = URL.createObjectURL(file);
  const source = new Image(); source.src = previewURL;
  setStatus('Loading your image and model…');
  try {
    await source.decode();
    if (token !== generation) return;
    $('uploadPreview').src = source.src; $('uploadPreview').hidden = false; $('designPreview').hidden = true;
    $('inputMessage').hidden = true; activeInput = 'upload';
    $('feedStatus').textContent = 'UPLOADED IMAGE · MODEL ACTIVE'; $('inputKind').textContent = 'IMAGE INPUT';
    await classifyStill(source, token);
    if (token === generation) setStatus('Image analyzed. Choose a bin, review the result, and save this scan if useful.');
  } catch (error) { if (token === generation) { resetResults(); setStatus('Could not analyze image: ' + error.message); } }
}
function readSavedScans() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(saved) || saved.some(s => !s || !CLASSES.includes(s.material) || !BIN_RULES[s.bin] || !Number.isFinite(s.confidence) || s.confidence < THRESHOLD || s.confidence > 1 || !Number.isFinite(s.time))) throw new Error('Invalid stored records');
    scans = saved;
  } catch (_) { storageAvailable = false; scans = []; }
}
function countsFor(records) { return Object.fromEntries(CLASSES.map(material => [material, records.filter(s => s.material === material).length])); }
function renderHistory() {
  const counts = countsFor(scans);
  $('totalCount').textContent = scans.length + ' items'; $('savedCount').textContent = scans.length + ' saved scans';
  CLASSES.forEach(c => $(c.toLowerCase() + 'Count').textContent = String(counts[c]));
  $('undo').disabled = scans.length === 0;
  $('resultUndo').disabled = scans.length === 0;
  $('reportSavedTotal').textContent = String(scans.length);
  $('reportActivityCount').textContent = scans.length + ' saved records';
  $('storageStatus').textContent = storageAvailable ? 'Saved on this browser and page origin only. No shared account or class-wide totals.' : 'Browser storage is unavailable or invalid. Counts are kept for this page session only.';
  $('emptyHistory').hidden = scans.length > 0; $('history').replaceChildren();
  scans.slice(-20).reverse().forEach(scan => {
    const li = document.createElement('li');
    const main = document.createElement('div'); const title = document.createElement('strong'); title.textContent = scan.material;
    const details = document.createElement('small');
    const match = BIN_RULES[scan.bin].accepts.includes(scan.material);
    details.textContent = (scan.confidence * 100).toFixed(1) + '% confidence · ' + BIN_RULES[scan.bin].name + ' · ' + (match ? 'demo match' : 'demo mismatch');
    const time = document.createElement('small'); time.textContent = new Date(scan.time).toLocaleString();
    const inspect = document.createElement('button'); inspect.className = 'history-record'; inspect.append(title, details); inspect.addEventListener('click', () => { cancelInput(false); latest = {material:scan.material, label:scan.material, probability:scan.confidence}; selectedBin=scan.bin; itemSaved=true; reportPhoto=null; reportSource='Saved record · '+new Date(scan.time).toLocaleString(); syncBins(); updateOutcome(); navigate('results'); });
    main.append(inspect); li.append(main, time); $('history').append(li);
  });
}
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(scans)); storageAvailable = true; }
  catch (_) { storageAvailable = false; }
  renderHistory();
}
function saveCurrentScan() {
  if (itemSaved || !latest || !latest.material || latest.probability < THRESHOLD || !BIN_RULES[selectedBin]) return;
  captureReportPhoto();
  scans.push({material: latest.material, confidence: latest.probability, bin: selectedBin, time: Date.now()});
  itemSaved = true; persist(); updateOutcome();
  $('resultSaveStatus').textContent = 'Saved ' + latest.material + '. Total: ' + scans.length + '. Photos are not stored.';
  $('saveStatus').textContent = 'Saved ' + latest.material + '. Total: ' + scans.length + '. Move to a different item and choose Next Item before saving again.';
}
document.querySelectorAll('[data-bin]').forEach(button => button.addEventListener('click', () => {
  selectedBin = button.dataset.bin;
  document.querySelectorAll('[data-bin]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  updateOutcome();
}));
$('startCamera').addEventListener('click', startCamera);
$('stopCamera').addEventListener('click', () => {
  cancelInput(); $('feedStatus').textContent = 'CAMERA STOPPED'; $('inputKind').textContent = 'NO LIVE INPUT';
  $('inputMessage').hidden = false; $('inputMessage').textContent = 'Camera stopped. Start Camera or upload another image.';
  setStatus('Camera stopped. Camera tracks have been released.');
});
$('cameraMode').addEventListener('click', () => { setMode('camera'); if (!stream) setStatus('Choose Start Camera to begin.'); });
$('uploadMode').addEventListener('click', () => {
  cancelInput(); beginNewItem(); setMode('upload'); $('feedStatus').textContent = 'UPLOAD MODE';
  setStatus('Choose or drop an image. Your image stays in this browser.');
});
$('fileInput').addEventListener('change', e => { const file = e.target.files[0]; e.target.value = ''; useImage(file); });
$('dropArea').addEventListener('dragover', e => e.preventDefault());
$('dropArea').addEventListener('drop', e => { e.preventDefault(); useImage(e.dataTransfer.files[0]); });
$('snapshot').addEventListener('click', async () => {
  if (!stream || $('video').readyState < 2) return;
  const photo = document.createElement('canvas'); photo.width = $('video').videoWidth; photo.height = $('video').videoHeight;
  photo.getContext('2d').drawImage($('video'), 0, 0);
  cancelInput(); const token = generation; activeInput = 'snapshot';
  const source = new Image(); source.src = photo.toDataURL('image/png');
  try {
    await source.decode(); if (token !== generation) return;
    $('uploadPreview').src = source.src; $('uploadPreview').hidden = false;
    $('inputMessage').hidden = true; $('feedStatus').textContent = 'SNAPSHOT · CAMERA STOPPED'; $('inputKind').textContent = 'STILL INPUT';
    await classifyStill(source, token); if (token === generation) setStatus('Snapshot analyzed. The camera is stopped.');
  } catch (error) { if (token === generation) setStatus('Snapshot failed: ' + error.message); }
});
$('flipLens').addEventListener('click', () => { facing = facing === 'environment' ? 'user' : 'environment'; startCamera(); });
$('saveScan').addEventListener('click', saveCurrentScan);
$('nextItem').addEventListener('click', () => {
  generation++; beginNewItem();
  if (stream) { predictionLoop(generation); setStatus('Show the next physical item to the camera.'); }
  else {
    activeInput = null; $('inputMessage').hidden = false; $('inputMessage').textContent = 'Start Camera or upload the next item.';
    setStatus('Upload a new image or start the camera for the next item.');
  }
});
$('undo').addEventListener('click', () => { if (scans.length) { scans.pop(); persist(); $('saveStatus').textContent = 'Last saved scan removed. Use Next Item before saving another item.'; $('resultSaveStatus').textContent = 'Last saved scan removed. Choose Scan Another Item for a new record.'; updateOutcome(); } });
$('help').addEventListener('click', () => $('helpDialog').showModal());
window.addEventListener('pagehide', () => { cancelInput(false); if (previewURL) URL.revokeObjectURL(previewURL); });
document.addEventListener('visibilitychange', () => { if (document.hidden && stream) { cancelInput(); setStatus('Camera stopped while the tab is hidden.'); } });


// Shared state and hash navigation for the four Figma screens.
let reportPhoto = null, reportSource = '', currentPage = 'scan';
const ROUTES = ['scan', 'results', 'campus', 'guidelines'];
function syncBins() {
  document.querySelectorAll('[data-bin]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.bin === selectedBin)));
  document.querySelectorAll('[data-result-bin]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.resultBin === selectedBin)));
}
function captureReportPhoto() {
  if (stream && $('video').readyState >= 2) {
    const c = document.createElement('canvas'); c.width = $('video').videoWidth; c.height = $('video').videoHeight;
    c.getContext('2d').drawImage($('video'), 0, 0); reportPhoto = c.toDataURL('image/jpeg', .8); reportSource = 'Camera capture · this session';
  } else if (activeInput && !$('uploadPreview').hidden && $('uploadPreview').src) {
    reportPhoto = $('uploadPreview').src; reportSource = activeInput === 'snapshot' ? 'Camera snapshot · this session' : 'Uploaded image · this session';
  }
}
function renderReport() {
  const r = evaluatePrediction(latest, selectedBin);
  $('reportBanner').className = 'verification-hero ' + r.state;
  $('reportLabel').textContent = ({neutral:'VERIFY YOUR ITEM',uncertain:'LOW CONFIDENCE · CHECK AGAIN',match:'DEMONSTRATION BIN MATCH',wrong:'DEMONSTRATION BIN MISMATCH'})[r.state];
  $('reportTitle').textContent = latest ? r.title : 'Your scan result will appear here';
  $('reportExplanation').textContent = latest ? r.detail : 'Analyze an item on Scan & Sort, then open its detailed result. Earlier saved scans are listed below.';
  const confidence = latest ? (latest.probability * 100).toFixed(1) + '%' : '—';
  const material = latest ? latest.material || latest.label : '—';
  $('reportBin').textContent = BIN_RULES[selectedBin] ? BIN_RULES[selectedBin].name : 'Not selected';
  $('reportConfidence').textContent = confidence;
  $('captureMaterial').textContent = material; $('captureConfidence').textContent = confidence;
  $('specMaterial').textContent = material; $('specConfidence').textContent = confidence;
  $('specProgress').value = latest ? latest.probability : 0;
  $('specRule').textContent = BIN_RULES[selectedBin] ? selectedBin + ' only' : 'Choose a bin';
  $('specRuleDetail').textContent = 'Demonstration acceptance; confirm actual school rules.';
  $('reportImage').hidden = !reportPhoto; $('reportImageEmpty').hidden = !!reportPhoto;
  if (reportPhoto) $('reportImage').src = reportPhoto; else $('reportImage').removeAttribute('src');
  $('reportInput').textContent = reportSource || 'No input captured';
  $('reportPhotoLabel').hidden = !reportPhoto || !latest;
  $('reportPhotoLabel').textContent = material + ' · ' + confidence;
  $('actionMaterial').textContent = latest ? 'The best visual match is ' + material + ' at ' + confidence + ' confidence. This is a prediction, not a verified material test.' : 'Analyze one item to see a material prediction.';
  $('actionPreparation').textContent = latest && latest.material && latest.probability >= THRESHOLD ? ADVICE[latest.material] : 'Wait for a result with at least 80% confidence, or ask someone to identify the item.';
  $('actionBin').textContent = latest && latest.material && latest.probability >= THRESHOLD ? 'The demonstration stream is ' + BIN_RULES[latest.material].name + '. Check the real label and ask staff before disposal.' : 'Check the actual bin label. Demonstration rules are not confirmed school policies.';
  CLASSES.forEach(c => { $('alternative-' + c).textContent = !latest ? 'WAITING' : latest.probability < THRESHOLD || !latest.material ? 'UNCERTAIN' : c === latest.material ? 'DEMO MATCH' : 'DEMO MISMATCH'; });
  $('alternativeAdvice').textContent = r.detail;
  $('saveResult').disabled = $('saveScan').disabled;
  $('saveResult').textContent = itemSaved ? 'Next Item Required' : 'Save This Scan';
  syncBins();
}
function showPage(page) {
  if (!ROUTES.includes(page)) page = 'scan';
  if (page !== 'scan' && currentPage === 'scan') { captureReportPhoto(); if (stream) { cancelInput(false); $('feedStatus').textContent = 'CAMERA STOPPED'; setStatus('Camera stopped while you view another page. Start Camera to resume.'); } }
  currentPage = page;
  document.querySelectorAll('[data-page]').forEach(view => view.hidden = view.dataset.page !== page);
  document.querySelectorAll('nav a').forEach(a => { if (a.hash === '#' + page) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
  renderReport();
  document.title = ({scan:'Scan & Sort',results:'Verification Result',campus:'Campus Impact & Bins',guidelines:'Sorting Guidelines'})[page] + ' | EcoSort AI · PCTVS';
  window.scrollTo({top:0,behavior:'instant'});
}
function navigate(page) { if (location.hash !== '#' + page) history.pushState(null,'','#'+page); showPage(page); }
document.addEventListener('click', event => {
  const a = event.target.closest('a[href^="#"]'); if (!a) return;
  const route = a.getAttribute('href').slice(1);
  if (ROUTES.includes(route)) { event.preventDefault(); navigate(route); }
});
window.addEventListener('popstate', () => showPage(location.hash.slice(1)));
window.addEventListener('hashchange', () => showPage(location.hash.slice(1)));
$('viewResult').addEventListener('click', () => navigate('results'));
$('scanAnother').addEventListener('click', () => { cancelInput(); beginNewItem(); $('inputMessage').hidden=false; $('inputMessage').textContent='Start Camera or upload your next item.'; navigate('scan'); });
$('saveResult').addEventListener('click', saveCurrentScan);
$('resultUndo').addEventListener('click', () => $('undo').click());
$('printResult').addEventListener('click', () => window.print());
$('printGuide').addEventListener('click', () => window.print());
document.querySelectorAll('[data-result-bin]').forEach(b => b.addEventListener('click', () => { selectedBin=b.dataset.resultBin; updateOutcome(); }));

// Illustrative directory: no sensor data or location verification is claimed.
const STATIONS = [
 {id:'stem',name:'STEM 1st Floor Station',wing:'STEM',detail:'Example: science and technology classrooms'},
 {id:'cafeteria',name:'Cafeteria Commons Hub',wing:'Athletics',detail:'Example: dining and common areas'},
 {id:'vocational',name:'Vocational Automotive Wing',wing:'Vocational',detail:'Example: shop instruction area; ask the instructor'}
];
function renderStations(wing='all') {
  $('stationList').replaceChildren();
  STATIONS.filter(s => wing==='all' || s.wing===wing).forEach(station => {
    const row=document.createElement('article'); row.className='station-row'; row.id='station-'+station.id;
    const head=document.createElement('div'); head.className='row'; const copy=document.createElement('div');
    const title=document.createElement('h3'); title.textContent=station.name; const detail=document.createElement('p'); detail.textContent=station.detail;
    copy.append(title,detail); const badge=document.createElement('small'); badge.textContent='UNVERIFIED LOCATION'; head.append(copy,badge);
    const bars=document.createElement('div'); bars.className='station-bars';
    CLASSES.forEach(c=>{const d=document.createElement('div'); const label=document.createElement('small');label.textContent=c+' · no live data';const bar=document.createElement('progress');bar.max=100;bar.value=0;bar.setAttribute('aria-label',c+' fill level unavailable');d.append(label,bar);bars.append(d);});
    row.append(head,bars);$('stationList').append(row);
  });
  document.querySelectorAll('[data-wing]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.wing===wing)));
  document.querySelectorAll('.map-pin').forEach(b=>{const station=STATIONS.find(s=>s.id===b.dataset.station);b.hidden=wing!=='all'&&station.wing!==wing;});
}
document.querySelectorAll('[data-wing]').forEach(b=>b.addEventListener('click',()=>renderStations(b.dataset.wing)));
document.querySelectorAll('[data-station]').forEach(b=>b.addEventListener('click',()=>{const station=STATIONS.find(s=>s.id===b.dataset.station);$('mapNote').textContent=station.name+' — example location; no live fill data. Confirm with school staff.';const row=$('station-'+station.id);if(row)row.scrollIntoView({behavior:'smooth',block:'nearest'});}));
$('reportIssue').addEventListener('click',()=>{$('issueStatus').textContent='';$('issueDialog').showModal();});
$('closeIssue').addEventListener('click',()=>$('issueDialog').close());
$('issueForm').addEventListener('submit',event=>{
 event.preventDefault(); const text=$('issueText').value.trim();if(!text)return;
 try{const key=STORAGE_KEY+'-issues';const old=JSON.parse(localStorage.getItem(key)||'[]');if(!Array.isArray(old))throw Error();old.push({station:$('issueStation').value,description:text,time:Date.now()});localStorage.setItem(key,JSON.stringify(old));$('issueText').value='';$('issueStatus').textContent='Saved locally on this browser. No report was sent to school staff.';}
 catch(_){$('issueStatus').textContent='Could not save the report. Browser storage may be blocked. Contact school staff directly.';}
});
function downloadText(name,text,type){const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('exportAudit').addEventListener('click',()=>{const rows=[['Time','Predicted material','Confidence','Selected demonstration bin','Demo comparison','Scope'],...scans.map(s=>[new Date(s.time).toISOString(),s.material,(s.confidence*100).toFixed(1)+'%',BIN_RULES[s.bin].name,BIN_RULES[s.bin].accepts.includes(s.material)?'match':'mismatch','Prediction only; disposal not verified'])];downloadText('EcoSort_Saved_Scans.csv',rows.map(row=>row.map(cell=>'"'+String(cell).replace(/"/g,'""')+'"').join(',')).join('\r\n'),'text/csv;charset=utf-8');});

// Searchable general-advice matrix. Specialty items are outside model coverage.
const MATERIALS=[
 ['Notebook & office paper','Paper','Classrooms / offices','Keep clean and dry; ask staff about bindings.'],
 ['Plastic beverage bottle','Plastic','Dining / common areas','Empty; rinse and check local acceptance and cap rules.'],
 ['Corrugated shipping box','Cardboard','Receiving / collection areas','Flatten, keep dry, remove packing inserts.'],
 ['Takeout coffee cup','Other','Confirm with staff','May contain mixed layers; do not assume paper-bin acceptance.'],
 ['Battery & electronic waste','Other','Approved staff collection','Outside model scope. Ask staff for the designated collection procedure.'],
 ['PLA filament & failed 3D prints','CTE','STEM lab: confirm with instructor','Dedicated collection only if the instructor confirms it.'],
 ['Metal turnings & culinary grease','CTE','Shop / culinary area: confirm with instructor','Follow the lab or shop collection procedure; outside model scope.']
];
let materialCategory='all';
function filterGuide(){
 const query=$('materialSearch').value.trim().toLowerCase();
 const rows=MATERIALS.filter(row=>(materialCategory==='all'||row[1]===materialCategory)&&row.join(' ').toLowerCase().includes(query));
 $('matrixRows').replaceChildren();
 rows.forEach(row=>{const tr=document.createElement('tr');[row[0],row[1]==='Other'?'Special handling':row[1]==='CTE'?'Instructor guidance':row[1]+' (demo)',row[2],row[3],'Confirm with staff'].forEach((value,i)=>{const td=document.createElement('td');if(i===1){const span=document.createElement('span');span.className='stream-tag';span.textContent=value;td.append(span);}else td.textContent=value;tr.append(td);});$('matrixRows').append(tr);});
 document.querySelectorAll('[data-material]').forEach(card=>{card.hidden=(materialCategory!=='all'&&materialCategory!==card.dataset.material)||(query&&!card.textContent.toLowerCase().includes(query));});
 $('vocationalPanel').hidden=materialCategory!=='all'&&materialCategory!=='CTE'||!!query&&!$('vocationalPanel').textContent.toLowerCase().includes(query);
 $('searchStatus').textContent=rows.length+' matching matrix '+(rows.length===1?'entry':'entries')+(query?' for “'+$('materialSearch').value.trim()+'”':'')+'. All collection rules require school confirmation.';
 document.querySelectorAll('[data-category]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.category===materialCategory)));
}
$('materialSearch').addEventListener('input',filterGuide);
document.querySelectorAll('[data-category]').forEach(b=>b.addEventListener('click',()=>{materialCategory=b.dataset.category;filterGuide();}));
readSavedScans(); renderHistory(); updateOutcome(); renderStations(); filterGuide(); showPage(location.hash.slice(1)||'scan');

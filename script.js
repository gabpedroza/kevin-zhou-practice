// script.js - Handouts Practice Selector (FSRS + Points + Titles)

document.addEventListener('DOMContentLoaded', () => {
    const PROGRESS_FILE_NAME = 'handouts_progress.json';
    const DATA_FILE_PATH = 'handouts_data.json';
    const SCOPES = 'https://www.googleapis.com/auth/drive.file';
    const CLIENT_ID = '855621511902-qmedc33ehce1jp0e15vjr41ua3smhlo7.apps.googleusercontent.com';

    const FSRS_PARAMS = {
        w: [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61],
        request_retention: 0.9,
        maximum_interval: 36500,
    };

    const CATEGORY_MAP = {
        'E': 'Electromagnetism',
        'M': 'Mechanics',
        'R': 'Relativity',
        'T': 'Thermodynamics',
        'W': 'Waves',
        'X': 'Extra'
    };

    let appState = {
        allQuestionsData: null,
        totalStats: {
            totalPointsAvailable: 0,
            totalProblems: 0,
            byCategory: {} 
        },
        progress: {
            version: 2,
            history: [],
            topics: {},
            pointsEarned: 0
        },
        accessToken: null,
        tokenClient: null,
        driveFileId: null
    };

    const dom = {
        loginBtn: document.getElementById('login-btn'),
        loadBtn: document.getElementById('load-progress-btn'),
        saveBtn: document.getElementById('save-progress-btn'),
        resetBtn: document.getElementById('reset-progress-btn'),
        syncStatus: document.getElementById('sync-status'),
        setupCard: document.getElementById('practice-setup'),
        numProblemsInput: document.getElementById('num-problems'),
        startSessionBtn: document.getElementById('start-session-btn'),
        sessionCard: document.getElementById('active-session'),
        sessionDashboard: document.getElementById('session-dashboard'),
        finishEarlyBtn: document.getElementById('finish-early-btn'),
        completionCard: document.getElementById('session-complete'),
        restartBtn: document.getElementById('restart-btn'),
        totalPointsEl: document.getElementById('total-points'),
        problemsSolvedEl: document.getElementById('problems-solved'),
        completionPctEl: document.getElementById('completion-pct'),
        granularStatsEl: document.getElementById('granular-stats')
    };

    init();

    function init() {
        fetchQuestionData();
        setupEventListeners();
        initGoogleAuth();
    }

    function initGoogleAuth() {
        if (typeof google === 'undefined') {
            setTimeout(initGoogleAuth, 100);
            return;
        }
        // Token client is initialized on demand if client ID changes
    }

    function requestToken() {
        if (CLIENT_ID === 'YOUR_GOOGLE_CLIENT_ID_HERE') {
            updateStatus('Please set your Google Client ID in script.js', true);
            return;
        }
        
        appState.tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: SCOPES,
            callback: (response) => {
                if (response.error !== undefined) {
                    updateStatus(`Auth error: ${response.error}`, true);
                    return;
                }
                appState.accessToken = response.access_token;
                dom.loadBtn.disabled = false;
                dom.saveBtn.disabled = false;
                updateStatus('Logged in to Google Drive.', false);
            },
        });
        appState.tokenClient.requestAccessToken();
    }

    function setupEventListeners() {
        dom.loginBtn.addEventListener('click', requestToken);
        dom.loadBtn.addEventListener('click', loadProgressFromDrive);
        dom.saveBtn.addEventListener('click', saveProgressToDrive);
        dom.resetBtn.addEventListener('click', resetAllProgress);
        dom.startSessionBtn.addEventListener('click', startSession);
        dom.finishEarlyBtn.addEventListener('click', finishSession);
        dom.restartBtn.addEventListener('click', resetSession);
    }

    function resetAllProgress() {
        if (!confirm('Are you sure you want to PERMANENTLY delete all study history?')) return;
        appState.progress = { version: 2, history: [], topics: {}, pointsEarned: 0 };
        updateStatus('Progress reset locally. Save to Drive to commit.', false);
        updateDashboard();
        resetSession();
    }

    const FSRS = {
        calculateInitial: (rating, points = 0) => {
            const w = FSRS_PARAMS.w;
            let d = w[4] - (rating - 3) * w[5];
            //if (points > 0) d += (points - 3) * 0.1;
            return { s: w[rating - 1], d: Math.max(1, Math.min(10, d)), state: 2 };
        },
        calculateReview: (prevS, prevD, rating, elapsedDays) => {
            const w = FSRS_PARAMS.w;
            let nextD = Math.max(1, Math.min(10, (w[7] * w[4] + (1 - w[7]) * (prevD - w[6] * (rating - 3)))));
            const retrievability = Math.pow(1 + elapsedDays / (9 * prevS), -1);
            if (rating === 1) return { s: w[11] * Math.pow(nextD, -w[12]) * (Math.pow(prevS + 1, w[13]) - 1) * Math.exp(w[14] * (1 - retrievability)), d: nextD, state: 3 };
            let factor = (rating === 2 ? w[15] : (rating === 4 ? w[16] : 1));
            const stabilityGrowth = Math.exp(w[8]) * (11 - nextD) * Math.pow(prevS, -w[9]) * (Math.exp(w[10] * (1 - retrievability)) - 1);
            return { s: prevS * (1 + stabilityGrowth * factor), d: nextD, state: 2 };
        },
        calculateNextInterval: (stability) => Math.min(Math.max(1, Math.round(9 * stability * ((1 / FSRS_PARAMS.request_retention) - 1))), FSRS_PARAMS.maximum_interval)
    };

    function updateDashboard() {
        if (!appState.allQuestionsData) return;
        const earned = appState.progress.pointsEarned || 0;
        const total = appState.totalStats.totalPointsAvailable;
        dom.totalPointsEl.textContent = earned;
        dom.problemsSolvedEl.textContent = appState.progress.history.length;
        dom.completionPctEl.textContent = total > 0 ? Math.round((earned / total) * 100) + '%' : '0%';

        const catStats = {};
        Object.keys(CATEGORY_MAP).forEach(c => catStats[c] = { earned: 0, solved: 0 });
        
        const historySet = new Set(appState.progress.history);
        for(const h in appState.allQuestionsData) {
            const cat = h[0].toUpperCase();
            if (!catStats[cat]) continue;
            const handoutData = appState.allQuestionsData[h];
            for(const t in handoutData.topics) {
                handoutData.topics[t].forEach(p => {
                    if (historySet.has(`${h}::${t}::${p.number}`)) {
                        catStats[cat].earned += p.points;
                        catStats[cat].solved++;
                    }
                });
            }
        }

        dom.granularStatsEl.innerHTML = '';
        Object.keys(CATEGORY_MAP).forEach(cat => {
            const catInfo = appState.totalStats.byCategory[cat];
            if (!catInfo) return;

            const handoutRows = [];
            const sortedHandouts = Object.keys(catInfo.handouts).sort();
            for (const filename of sortedHandouts) {
                const h = catInfo.handouts[filename];
                let hEarned = 0, hSolved = 0;
                const handoutData = appState.allQuestionsData[filename];
                for (const t in handoutData.topics) {
                    handoutData.topics[t].forEach(p => {
                        if (historySet.has(`${filename}::${t}::${p.number}`)) {
                            hEarned += p.points; hSolved++;
                        }
                    });
                }
                const hPct = Math.round((hEarned / h.points) * 100);
                handoutRows.push(`
                    <div class="handout-row">
                        <div class="handout-title" title="${h.title}">${filename.replace('.pdf','')}: ${h.title}</div>
                        <div class="progress-bar-container"><div class="progress-bar-fill" style="width: ${hPct}%"></div></div>
                        <div>${hEarned}/${h.points}</div>
                        <div>${hSolved}/${h.probs}</div>
                    </div>
                `);
            }

            const catPct = Math.round((catStats[cat].earned / catInfo.points) * 100);
            const group = document.createElement('div');
            group.className = 'category-group';
            group.innerHTML = `
                <div class="category-header">
                    <span>${cat} - ${CATEGORY_MAP[cat]} (${catPct}%)</span>
                    <span class="arrow">▼</span>
                </div>
                <div class="category-content">${handoutRows.join('')}</div>
            `;
            group.querySelector('.category-header').addEventListener('click', () => group.classList.toggle('open'));
            dom.granularStatsEl.appendChild(group);
        });
    }

    async function fetchQuestionData() {
        try {
            const res = await fetch(DATA_FILE_PATH);
            appState.allQuestionsData = await res.json();
            for (const filename in appState.allQuestionsData) {
                const data = appState.allQuestionsData[filename];
                const cat = filename[0].toUpperCase();
                if (!CATEGORY_MAP[cat]) continue;
                if (!appState.totalStats.byCategory[cat]) appState.totalStats.byCategory[cat] = { points: 0, probs: 0, handouts: {} };
                
                let hPoints = 0, hProbs = 0;
                for (const t in data.topics) {
                    const probs = data.topics[t];
                    hProbs += probs.length;
                    probs.forEach(p => hPoints += p.points);
                }
                appState.totalStats.totalProblems += hProbs;
                appState.totalStats.totalPointsAvailable += hPoints;
                appState.totalStats.byCategory[cat].probs += hProbs;
                appState.totalStats.byCategory[cat].points += hPoints;
                appState.totalStats.byCategory[cat].handouts[filename] = { title: data.title, points: hPoints, probs: hProbs };
            }
            updateDashboard();
        } catch (e) { updateStatus("Error loading data: " + e.message, true); }
    }

    function startSession() {
        if (!appState.allQuestionsData) return;
        const num = parseInt(dom.numProblemsInput.value, 10) || 3;
        const topics = [];
        for (const h in appState.allQuestionsData) 
            for (const t in appState.allQuestionsData[h].topics)
                topics.push({ id: `${h}::${t}`, handout: h, name: t });
        
        const now = new Date();
        const due = topics.filter(t => !appState.progress.topics[t.id] || new Date(appState.progress.topics[t.id].due) <= now);
        shuffleArray(due);
        
        let selected = due.slice(0, num);
        if (selected.length < num) {
            // Priority 2: Not due yet, but sort by closest due date
            const notDue = topics.filter(t => !selected.includes(t));
            notDue.sort((a, b) => {
                const dateA = new Date(appState.progress.topics[a.id].due);
                const dateB = new Date(appState.progress.topics[b.id].due);
                return dateA - dateB;
            });
            selected = selected.concat(notDue.slice(0, num - selected.length));
        }

        appState.currentSession = [];
        const hist = new Set(appState.progress.history);
        selected.forEach(t => {
            const allInTopic = appState.allQuestionsData[t.handout].topics[t.name];
            const available = allInTopic.filter(q => !hist.has(`${t.handout}::${t.name}::${q.number}`));
            
            // Pick an unsolved one if possible, otherwise pick any from the topic for review
            const q = available.length > 0 
                ? available[Math.floor(Math.random() * available.length)]
                : allInTopic[Math.floor(Math.random() * allInTopic.length)];

            if (q) {
                appState.currentSession.push({ 
                    question: { ...q, handout: t.handout, topic: t.name, id: `${t.handout}::${t.name}::${q.number}` }, 
                    mainTopicId: t.id, 
                    isDone: false 
                });
            }
        });
        if (!appState.currentSession.length) return alert("No new problems!");
        dom.setupCard.style.display = 'none'; dom.sessionCard.style.display = 'block';
        renderSession();
    }

    function renderSession() {
        dom.sessionDashboard.innerHTML = '';
        appState.currentSession.forEach(item => {
            const card = document.createElement('div');
            card.className = 'problem-card';
            card.innerHTML = `
                <div class="problem-header">
                    <h3>${item.question.handout} - ${item.question.number} <span style="background:#3498db; color:white; padding:2px 6px; border-radius:4px; font-size:0.8em; margin-left:8px;">${item.question.points} pts</span></h3>
                    <div class="problem-meta">${item.question.topic}</div>
                </div>
                <a class="button-link" target="_blank" href="${item.question.link}">Open Handout</a>
                <div class="rate-area" style="margin-top:15px;"><button style="width:100%">Mark as Done</button></div>
            `;
            card.querySelector('button').addEventListener('click', () => {
                card.querySelector('.rate-area').innerHTML = `
                    <details class="rating-help">
                        <summary>What do these grades mean?</summary>
                        <div class="details-content">
                            <p><strong>Again:</strong> Total blackout, didn't know where to start.</p>
                            <p><strong>Hard:</strong> Solved it, but with major struggle or hints.</p>
                            <p><strong>Good:</strong> Standard effort, correct solution.</p>
                            <p><strong>Easy:</strong> Solved instantly without effort.</p>
                        </div>
                    </details>
                    <div class="rating-buttons">
                        <button class="rate-btn" data-r="1">Again</button>
                        <button class="rate-btn" data-r="2">Hard</button>
                        <button class="rate-btn" data-r="3">Good</button>
                        <button class="rate-btn" data-r="4">Easy</button>
                    </div>
                `;
                card.querySelectorAll('.rate-btn').forEach(btn => btn.addEventListener('click', () => {
                    handleRating(item, parseInt(btn.dataset.r));
                    card.classList.add('completed');
                    card.querySelector('.rate-area').innerHTML = '<div style="color:var(--success-color); font-weight:bold; margin-top:10px;">Completed</div>';
                }));
            });
            dom.sessionDashboard.appendChild(card);
        });
    }

    function handleRating(item, r) {
        const now = new Date(); item.isDone = true;
        
        // Only award points and mark as "solved" if they passed (rating > 1)
        if (r > 1 && !appState.progress.history.includes(item.question.id)) {
            appState.progress.history.push(item.question.id);
            appState.progress.pointsEarned += item.question.points;
        }
        
        let t = appState.progress.topics[item.mainTopicId] || { last_review: now.toISOString() };
        let n = !t.stability ? FSRS.calculateInitial(r, item.question.points) : FSRS.calculateReview(t.stability, t.difficulty, r, (now - new Date(t.last_review)) / 86400000);
        Object.assign(t, { state: n.state, stability: n.s, difficulty: n.d, last_review: now.toISOString(), due: new Date(now.getTime() + FSRS.calculateNextInterval(n.s) * 86400000).toISOString() });
        appState.progress.topics[item.mainTopicId] = t;
        updateDashboard();
        if (appState.currentSession.every(i => i.isDone)) setTimeout(() => { if(confirm("Session complete! Finish?")) finishSession(); }, 500);
    }

    function finishSession() { dom.sessionCard.style.display = 'none'; dom.completionCard.style.display = 'block'; }
    function resetSession() { dom.completionCard.style.display = 'none'; dom.setupCard.style.display = 'block'; }
    function shuffleArray(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } }

    async function driveApiFetch(url, options = {}) {
        if (!appState.accessToken) throw new Error('Not logged in.');
        const res = await fetch(`https://www.googleapis.com${url}`, {
            ...options,
            headers: {
                'Authorization': `Bearer ${appState.accessToken}`,
                'Content-Type': 'application/json',
                ...options.headers
            }
        });
        if (!res.ok) {
            if (res.status === 401) {
                appState.accessToken = null;
                throw new Error('Session expired. Please login again.');
            }
            throw new Error(`Drive API ${res.status}`);
        }
        return res.json();
    }

    async function findProgressFile() {
        const query = encodeURIComponent(`name = '${PROGRESS_FILE_NAME}' and trashed = false`);
        const data = await driveApiFetch(`/drive/v3/files?q=${query}&fields=files(id,name)`);
        return data.files.length > 0 ? data.files[0].id : null;
    }

    async function loadProgressFromDrive() {
        updateStatus('Searching Drive...');
        try {
            const fileId = await findProgressFile();
            if (!fileId) {
                updateStatus('No file found. Save to create one.', false);
                return;
            }
            appState.driveFileId = fileId;
            updateStatus('Downloading...');
            const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
                headers: { 'Authorization': `Bearer ${appState.accessToken}` }
            });
            if (!res.ok) throw new Error(`Download failed: ${res.status}`);
            appState.progress = await res.json();
            if (appState.progress.pointsEarned === undefined) recalcPoints();
            updateStatus('Loaded.', false); updateDashboard();
        } catch (e) { updateStatus(`Error: ${e.message}`, true); }
    }

    async function saveProgressToDrive() {
        updateStatus('Saving...');
        try {
            if (!appState.driveFileId) appState.driveFileId = await findProgressFile();
            
            const metadata = { name: PROGRESS_FILE_NAME, mimeType: 'application/json' };
            const content = JSON.stringify(appState.progress, null, 2);
            
            let url, method;
            if (appState.driveFileId) {
                // Update existing file (creates a new version automatically)
                url = `https://www.googleapis.com/upload/drive/v3/files/${appState.driveFileId}?uploadType=media`;
                method = 'PATCH';
            } else {
                // Create new file
                // First create metadata, then upload content. Simple way: multipart.
                // For simplicity here, we'll do the two-step create or just use multipart.
                // Let's use a simpler two-step for "very simple adaptation":
                const createRes = await driveApiFetch('/drive/v3/files', {
                    method: 'POST',
                    body: JSON.stringify(metadata)
                });
                appState.driveFileId = createRes.id;
                url = `https://www.googleapis.com/upload/drive/v3/files/${appState.driveFileId}?uploadType=media`;
                method = 'PATCH';
            }

            const res = await fetch(url, {
                method: method,
                headers: {
                    'Authorization': `Bearer ${appState.accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: content
            });

            if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
            updateStatus('Saved to Drive!', false);
        } catch (e) { updateStatus(`Save failed: ${e.message}`, true); }
    }

    function recalcPoints() {
        if (!appState.allQuestionsData) return;
        let pts = 0; const hSet = new Set(appState.progress.history);
        for(const h in appState.allQuestionsData) for(const t in appState.allQuestionsData[h].topics)
            appState.allQuestionsData[h].topics[t].forEach(p => { if (hSet.has(`${h}::${t}::${p.number}`)) pts += p.points; });
        appState.progress.pointsEarned = pts;
    }

    function updateStatus(msg, isErr) { dom.syncStatus.textContent = msg; dom.syncStatus.style.color = isErr ? '#e74c3c' : '#27ae60'; }
});

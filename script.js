// script.js - Handouts Practice Selector (FSRS + Points)

document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration & Constants ---
    const GITHUB_API_BASE = 'https://api.github.com/repos';
    const PROGRESS_FILE_PATH = 'handouts_progress.json';
    const DATA_FILE_PATH = 'handouts_data.json';
    
    // FSRS Constants (Standard v4.5 Default Parameters)
    const FSRS_PARAMS = {
        w: [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61],
        request_retention: 0.9,
        maximum_interval: 36500,
    };

    // --- State ---
    let appState = {
        allQuestionsData: null,   // handouts_data.json content
        totalStats: {
            totalPointsAvailable: 0,
            totalProblems: 0
        },
        progress: {               // The user's progress data
            version: 2,
            history: [],          // Array of completed question IDs
            topics: {},           // Map: topicId -> { state, stability, difficulty, due, last_review }
            pointsEarned: 0       // New: Track points separately
        },
        githubFileSha: null,
        currentSession: [],       // Array of { question, mainTopicId, id (temp UUID) }
    };

    // --- DOM Elements ---
    const dom = {
        repoInput: document.getElementById('github-repo'),
        patInput: document.getElementById('github-pat'),
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

        // Dashboard Stats
        totalPointsEl: document.getElementById('total-points'),
        problemsSolvedEl: document.getElementById('problems-solved'),
        masteryScoreEl: document.getElementById('mastery-score'),
        completionTextEl: document.getElementById('completion-text'),
        overallProgressEl: document.getElementById('overall-progress')
    };

    // --- Initialization ---
    init();

    function init() {
        loadLocalConfig();
        fetchQuestionData();
        setupEventListeners();
    }

    function setupEventListeners() {
        dom.loadBtn.addEventListener('click', loadProgressFromGithub);
        dom.saveBtn.addEventListener('click', saveProgressToGithub);
        dom.resetBtn.addEventListener('click', resetAllProgress);
        dom.startSessionBtn.addEventListener('click', startSession);
        dom.finishEarlyBtn.addEventListener('click', finishSession);
        dom.restartBtn.addEventListener('click', resetSession);
    }

    function resetAllProgress() {
        if (!confirm('Are you sure you want to PERMANENTLY delete all study history and FSRS data? This cannot be undone until you save back to GitHub.')) {
            return;
        }

        appState.progress = {
            version: 2,
            history: [],
            topics: {},
            pointsEarned: 0
        };
        
        updateStatus('Progress reset locally. Save to GitHub to commit changes.', false);
        updateDashboard();
        resetSession();
    }

    // --- FSRS Implementation (With Points Modification) ---
    const FSRS = {
        State: { New: 0, Learning: 1, Review: 2, Relearning: 3 },
        Rating: { Again: 1, Hard: 2, Good: 3, Easy: 4 },

        calculateInitial: (rating, points = 0) => {
            const w = FSRS_PARAMS.w;
            const r_idx = rating - 1; 
            const s = w[r_idx];
            
            // Base difficulty from rating
            let d = w[4] - (rating - 3) * w[5];
            
            // POINTS MODIFICATION:
            // Assuming average problem is ~3 points.
            // Add slight difficulty bump for high point problems.
            // 0.1 is a conservative factor. A 10pt problem adds +0.7 to difficulty vs a 3pt problem.
            if (points > 0) {
                d += (points - 3) * 0.1;
            }

            return {
                s: s,
                d: Math.max(1, Math.min(10, d)),
                state: FSRS.State.Review 
            };
        },

        calculateReview: (prevS, prevD, rating, elapsedDays) => {
            const w = FSRS_PARAMS.w;
            let nextD = prevD - w[6] * (rating - 3);
            nextD = FSRS.MeanReversion(w[4], nextD);
            nextD = Math.max(1, Math.min(10, nextD));

            if (rating === FSRS.Rating.Again) {
                 const nextS = w[11] * Math.pow(nextD, -w[12]) * (Math.pow(prevS + 1, w[13]) - 1) * Math.exp(w[14] * (1 - FSRS_PARAMS.request_retention));
                 return { s: nextS, d: nextD, state: FSRS.State.Relearning };
            }

            const retrievability = Math.pow(1 + elapsedDays / (9 * prevS), -1);
            let hardPenalty = rating === FSRS.Rating.Hard ? w[15] : 1;
            let easyBonus = rating === FSRS.Rating.Easy ? w[16] : 1;

            const stabilityGrowth = Math.exp(w[8]) * (11 - nextD) * Math.pow(prevS, -w[9]) * (Math.exp(w[10] * (1 - retrievability)) - 1);
            const nextS = prevS * (1 + stabilityGrowth * hardPenalty * easyBonus);
            
            return { s: nextS, d: nextD, state: FSRS.State.Review };
        },

        MeanReversion: (initD, currentD) => {
             const w = FSRS_PARAMS.w;
             return w[7] * initD + (1 - w[7]) * currentD;
        },

        calculateNextInterval: (stability) => {
            const newInterval = 9 * stability * ((1 / FSRS_PARAMS.request_retention) - 1);
            return Math.min(Math.max(1, Math.round(newInterval)), FSRS_PARAMS.maximum_interval);
        }
    };

    // --- Core Logic ---

    function startSession() {
        if (!appState.allQuestionsData) {
            updateStatus('Data not loaded yet.', true);
            return;
        }

        const numProblems = parseInt(dom.numProblemsInput.value, 10) || 3;
        const allTopics = getAllTopics(); // Returns topic objects
        
        const now = new Date();
        const dueTopics = allTopics.filter(t => {
            const topicData = appState.progress.topics[t.id];
            if (!topicData) return true; // New topic is always due
            return new Date(topicData.due) <= now;
        });

        // Heuristic: Weight selection by average points of topic? 
        // For now, keep it random shuffle among due.
        shuffleArray(dueTopics);

        let selectedTopics = [];
        if (dueTopics.length >= numProblems) {
            selectedTopics = dueTopics.slice(0, numProblems);
        } else {
            selectedTopics = [...dueTopics];
            const needed = numProblems - selectedTopics.length;
            const otherTopics = allTopics.filter(t => !selectedTopics.includes(t));
            shuffleArray(otherTopics);
            selectedTopics = selectedTopics.concat(otherTopics.slice(0, needed));
        }

        appState.currentSession = [];
        const historySet = new Set(appState.progress.history);

        selectedTopics.forEach(topic => {
            const handoutName = topic.handout;
            const topicName = topic.name;
            
            const handoutData = appState.allQuestionsData[handoutName];
            if (!handoutData) return;
            
            const questions = handoutData[topicName]; // Array of objects now
            if (!Array.isArray(questions)) return;

            const availableQuestions = questions.filter(q => {
                const uniqueId = `${handoutName}::${topicName}::${q.number}`;
                return !historySet.has(uniqueId);
            });

            if (availableQuestions.length > 0) {
                const randomQ = availableQuestions[Math.floor(Math.random() * availableQuestions.length)];
                appState.currentSession.push({
                    sessionId: Math.random().toString(36).substr(2, 9),
                    question: {
                        ...randomQ, // number, points, link
                        handout: handoutName,
                        topic: topicName,
                        id: `${handoutName}::${topicName}::${randomQ.number}`
                    },
                    mainTopicId: topic.id, // e.g., "E7.pdf::Topic 1"
                    isDone: false
                });
            }
        });

        if (appState.currentSession.length === 0) {
            alert("No new questions available for the selected topics! You've completed everything!");
            return;
        }

        // Start Dashboard
        dom.setupCard.style.display = 'none';
        dom.sessionCard.style.display = 'block';
        dom.completionCard.style.display = 'none';
        
        renderSessionDashboard();
    }

    function renderSessionDashboard() {
        dom.sessionDashboard.innerHTML = '';
        appState.currentSession.forEach(item => {
            const card = createProblemCard(item);
            dom.sessionDashboard.appendChild(card);
        });
    }

    function createProblemCard(item) {
        const card = document.createElement('div');
        card.className = 'problem-card';
        if (item.isDone) card.classList.add('completed');

        // Header
        const header = document.createElement('div');
        header.className = 'problem-header';
        
        // Show Points badge
        const pointsBadge = `<span class="points-badge" style="background:#3498db; color:white; padding:2px 6px; border-radius:4px; font-size:0.8em; margin-left:8px;">${item.question.points} pts</span>`;

        header.innerHTML = `
            <h3>${item.question.handout} - ${item.question.number} ${pointsBadge}</h3>
            <div class="problem-meta">${item.question.topic}</div>
        `;
        card.appendChild(header);

        // Link
        const link = document.createElement('a');
        link.className = 'button-link';
        link.target = '_blank';
        link.textContent = 'Open Handout';
        link.href = item.question.link; 
        
        card.appendChild(link);

        // Actions
        if (!item.isDone) {
            const controls = document.createElement('div');
            controls.style.marginTop = '15px';
            
            const markBtn = document.createElement('button');
            markBtn.textContent = 'Mark as Done';
            markBtn.style.width = '100%';
            
            markBtn.addEventListener('click', () => {
                controls.remove();
                renderRatingInterface(card, item);
            });
            
            controls.appendChild(markBtn);
            card.appendChild(controls);
        } else {
            const doneMsg = document.createElement('div');
            doneMsg.style.color = 'var(--success-color)';
            doneMsg.style.fontWeight = 'bold';
            doneMsg.style.marginTop = '15px';
            doneMsg.textContent = 'Completed';
            card.appendChild(doneMsg);
        }

        return card;
    }

    function renderRatingInterface(card, item) {
        const container = document.createElement('div');
        container.className = 'card-rating-area';

        // 2. Rating Buttons
        const rateLabel = document.createElement('div');
        rateLabel.innerHTML = '<strong>Rate Difficulty:</strong>';
        rateLabel.style.marginTop = '15px';
        container.appendChild(rateLabel);

        const btnGroup = document.createElement('div');
        btnGroup.className = 'rating-buttons';

        [1, 2, 3, 4].forEach(rating => {
            const btn = document.createElement('button');
            btn.className = 'rate-btn';
            btn.dataset.rating = rating;
            btn.textContent = ['Again (1)', 'Hard (2)', 'Good (3)', 'Easy (4)'][rating-1];
            
            btn.addEventListener('click', () => {
                handleCardRating(item, rating);
                // Remove interface and mark completed visual
                container.remove();
                card.classList.add('completed');
                const doneMsg = document.createElement('div');
                doneMsg.style.color = 'var(--success-color)';
                doneMsg.style.fontWeight = 'bold';
                doneMsg.style.marginTop = '15px';
                doneMsg.textContent = 'Completed';
                card.appendChild(doneMsg);
            });
            btnGroup.appendChild(btn);
        });

        container.appendChild(btnGroup);
        card.appendChild(container);
    }

    function handleCardRating(item, rating) {
        const now = new Date();
        item.isDone = true;

        // 1. History
        if (!appState.progress.history.includes(item.question.id)) {
            appState.progress.history.push(item.question.id);
            // Add points
            appState.progress.pointsEarned = (appState.progress.pointsEarned || 0) + (item.question.points || 0);
        }

        // 2. FSRS Update (Only for the main topic)
        // Unlike the Tripos selector, handouts usually have one clear topic per problem section.
        const topicId = item.mainTopicId;
        
        let topicState = appState.progress.topics[topicId];
        let next;

        if (!topicState) {
            // Pass points to influence initial difficulty
            const initial = FSRS.calculateInitial(rating, item.question.points);
            next = { state: initial.state, s: initial.s, d: initial.d };
            topicState = { last_review: now.toISOString() };
        } else {
            const lastReview = new Date(topicState.last_review);
            const elapsedDays = (now - lastReview) / (1000 * 60 * 60 * 24);
            next = FSRS.calculateReview(topicState.stability, topicState.difficulty, rating, elapsedDays);
        }

        topicState.state = next.state;
        topicState.stability = next.s;
        topicState.difficulty = next.d;
        topicState.last_review = now.toISOString();

        const interval = FSRS.calculateNextInterval(topicState.stability);
        const dueDate = new Date(now);
        dueDate.setDate(dueDate.getDate() + interval);
        topicState.due = dueDate.toISOString();

        appState.progress.topics[topicId] = topicState;
        
        updateDashboard();

        // Check if all done
        if (appState.currentSession.every(i => i.isDone)) {
             setTimeout(() => {
                 if(confirm("All problems completed! Finish session?")) {
                     finishSession();
                 }
             }, 500);
        }
    }

    function finishSession() {
        dom.sessionCard.style.display = 'none';
        dom.completionCard.style.display = 'block';
    }

    function resetSession() {
        dom.completionCard.style.display = 'none';
        dom.setupCard.style.display = 'block';
        dom.numProblemsInput.value = 3;
    }

    function updateDashboard() {
        if (!appState.totalStats.totalPointsAvailable) return;

        const earned = appState.progress.pointsEarned || 0;
        const total = appState.totalStats.totalPointsAvailable;
        const solved = appState.progress.history.length;
        
        dom.totalPointsEl.textContent = earned;
        dom.problemsSolvedEl.textContent = solved;
        
        const percent = Math.round((earned / total) * 100);
        dom.completionTextEl.textContent = `${earned} / ${total} Points`;
        dom.overallProgressEl.style.width = `${percent}%`;

        // Calculate a "Mastery Score"
        // Average stability of all started topics? 
        // Or just points %? Let's use Points % for simplicity, or a mix.
        // Let's make Mastery Score reflect FSRS Stability.
        const topics = Object.values(appState.progress.topics);
        if (topics.length > 0) {
            const avgStability = topics.reduce((acc, t) => acc + t.stability, 0) / topics.length;
            // Normalize stability (e.g. 365 days = 100% mastery?) roughly.
            // Log scale might be better. 
            // Let's just stick to Points % as "Completion" and maybe "Retention" as avg stability.
            // Actually, let's keep Mastery as Points % for now, straightforward.
            dom.masteryScoreEl.textContent = `${percent}%`;
        } else {
            dom.masteryScoreEl.textContent = "0%";
        }
    }

    // --- Helpers ---

    function getAllTopics() {
        if (!appState.allQuestionsData) return [];
        const topics = [];
        for (const handoutName in appState.allQuestionsData) {
            const handoutData = appState.allQuestionsData[handoutName];
            for (const topicName in handoutData) {
                // Ensure it's not metadata
                if (Array.isArray(handoutData[topicName])) {
                    topics.push({
                        id: `${handoutName}::${topicName}`,
                        handout: handoutName,
                        name: topicName
                    });
                }
            }
        }
        return topics;
    }

    function shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    // --- Data Loading & GitHub ---

    async function fetchQuestionData() {
        try {
            const response = await fetch(DATA_FILE_PATH);
            if (!response.ok) throw new Error(`${DATA_FILE_PATH} not found.`);
            appState.allQuestionsData = await response.json();
            
            // Calculate totals once
            let tPoints = 0;
            let tProbs = 0;
            for(const h in appState.allQuestionsData) {
                for(const t in appState.allQuestionsData[h]) {
                    const probs = appState.allQuestionsData[h][t];
                    if(Array.isArray(probs)) {
                        tProbs += probs.length;
                        probs.forEach(p => tPoints += (p.points || 0));
                    }
                }
            }
            appState.totalStats.totalPointsAvailable = tPoints;
            appState.totalStats.totalProblems = tProbs;
            
            updateDashboard();

        } catch (error) {
            updateStatus(`Error loading data: ${error.message}`, true);
        }
    }

    function loadLocalConfig() {
        const repo = localStorage.getItem('githubRepo');
        const pat = localStorage.getItem('githubPat');
        if (repo) dom.repoInput.value = repo;
        if (pat) dom.patInput.value = pat;
    }

    async function githubApiFetch(url, options = {}) {
        const repo = dom.repoInput.value;
        const pat = dom.patInput.value;

        if (!repo || !pat) throw new Error('Repo and Token required.');
        localStorage.setItem('githubRepo', repo);
        localStorage.setItem('githubPat', pat);

        const headers = {
            'Authorization': `Bearer ${pat}`,
            'Accept': 'application/vnd.github.v3+json',
            ...options.headers,
        };

        const response = await fetch(`${GITHUB_API_BASE}/${repo}${url}`, { ...options, headers });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(`GitHub API ${response.status}: ${err.message || response.statusText}`);
        }
        return response.json();
    }

    async function loadProgressFromGithub() {
        updateStatus('Loading...');
        try {
            const data = await githubApiFetch(`/contents/${PROGRESS_FILE_PATH}`);
            appState.githubFileSha = data.sha;
            const content = atob(data.content);
            const json = JSON.parse(content);

            if (json.version !== 2) {
                 // Simple migration if needed, or just load
                 appState.progress = json;
            } else {
                appState.progress = json;
            }
            
            // Recalculate points if missing from progress (backward compatibility)
            if (appState.progress.pointsEarned === undefined) {
                recalcPointsFromHistory();
            }

            updateStatus(`Loaded progress. History: ${appState.progress.history.length}`, false);
            updateDashboard();
        } catch (error) {
            if (error.message.includes('404')) {
                updateStatus('No progress file found. Starting fresh.', false);
                appState.githubFileSha = null;
                appState.progress = { version: 2, history: [], topics: {}, pointsEarned: 0 };
                updateDashboard();
            } else {
                updateStatus(`Error: ${error.message}`, true);
            }
        }
    }
    
    function recalcPointsFromHistory() {
        let pts = 0;
        const historySet = new Set(appState.progress.history);
        for(const h in appState.allQuestionsData) {
            for(const t in appState.allQuestionsData[h]) {
                const probs = appState.allQuestionsData[h][t];
                if(Array.isArray(probs)) {
                    probs.forEach(p => {
                        const id = `${h}::${t}::${p.number}`;
                        if (historySet.has(id)) {
                            pts += (p.points || 0);
                        }
                    });
                }
            }
        }
        appState.progress.pointsEarned = pts;
    }

    async function saveProgressToGithub() {
        updateStatus('Saving...');
        const content = btoa(JSON.stringify(appState.progress, null, 2));
        
        try {
            try {
                const check = await githubApiFetch(`/contents/${PROGRESS_FILE_PATH}`);
                appState.githubFileSha = check.sha;
            } catch (e) { /* ignore */ }

            const body = {
                message: `Update progress (FSRS) - ${new Date().toISOString()}`,
                content: content
            };
            if (appState.githubFileSha) body.sha = appState.githubFileSha;

            const res = await githubApiFetch(`/contents/${PROGRESS_FILE_PATH}`, {
                method: 'PUT',
                body: JSON.stringify(body)
            });
            
            appState.githubFileSha = res.content.sha;
            updateStatus('Saved successfully!', false);
        } catch (error) {
            updateStatus(`Save failed: ${error.message}`, true);
        }
    }

    function updateStatus(msg, isError) {
        dom.syncStatus.textContent = msg;
        dom.syncStatus.style.color = isError ? '#e74c3c' : '#27ae60';
    }
});

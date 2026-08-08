async function extractErrorMessage(response, fallback) {
    const body = await response.json().catch(() => ({}));
    return body.message || fallback;
}

class ThemeManager {
    constructor() {
        this.themeToggle = document.getElementById('themeToggle');
        this.initialize();
    }
    initialize() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        this.setTheme(savedTheme);
        this.themeToggle?.addEventListener('click', () => this.toggleTheme());
    }
    setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
        const icon = this.themeToggle.querySelector('i');
        if (icon) icon.className = theme === 'light' ? 'fas fa-moon' : 'fas fa-sun';
    }
    toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        this.setTheme(currentTheme === 'light' ? 'dark' : 'light');
    }
}

class ReviewManager {
    constructor() {
        this.modal = document.getElementById('mergeConfirmModal');
        this.previewText = document.getElementById('mergePreviewText');
        this.previewExamples = document.getElementById('mergePreviewExamples');
        this.reverseToggle = document.getElementById('mergeReverseToggle');
        this.confirmBtn = document.getElementById('confirmMerge');
        this.pendingMergeId = null;
        this.pendingDocumentIds = null;
        this.pendingReverse = false;
        this.pendingInfo = null;
        this.docPreviewModal = document.getElementById('previewModal');
        this.docPreviewContent = document.getElementById('previewContent');
        this.initialize();
    }

    initialize() {
        document.querySelectorAll('.preview-btn').forEach(btn => {
            btn.addEventListener('click', () => this.showDocumentPreview(btn.dataset.id));
        });
        document.querySelectorAll('.merge-btn').forEach(btn => {
            btn.addEventListener('click', () => this.previewMerge(btn));
        });
        document.querySelectorAll('.reject-btn').forEach(btn => {
            btn.addEventListener('click', () => this.reject(btn.dataset.id, btn));
        });
        document.querySelectorAll('.backfill-btn').forEach(btn => {
            btn.addEventListener('click', () => this.backfill(btn.dataset.entityType, btn));
        });
        document.querySelectorAll('.ask-judge-btn').forEach(btn => {
            btn.addEventListener('click', () => this.askJudge(btn.dataset.id, btn));
        });
        document.getElementById('bulkRejectBtn')?.addEventListener('click', () => this.bulkReject());

        this.modal?.querySelector('.modal-overlay')?.addEventListener('click', () => this.hideModal());
        this.modal?.querySelector('.modal-close')?.addEventListener('click', () => this.hideModal());
        document.getElementById('cancelMerge')?.addEventListener('click', () => this.hideModal());
        this.confirmBtn?.addEventListener('click', () => this.confirmMerge());
        this.reverseToggle?.addEventListener('change', () => {
            this.loadMergeDirection(this.reverseToggle.checked).catch(error => {
                console.error('Failed to switch merge direction:', error);
                alert(error.message || 'Failed to switch merge direction. Please try again.');
            });
        });

        this.docPreviewModal?.querySelector('.modal-overlay')?.addEventListener('click', () => this.hideDocumentPreview());
        this.docPreviewModal?.querySelector('.modal-close')?.addEventListener('click', () => this.hideDocumentPreview());
    }

    async showDocumentPreview(id) {
        try {
            const response = await fetch(`/api/review/${id}/documents`);
            if (!response.ok) throw new Error('Failed to load example documents');
            const data = await response.json();

            this.docPreviewContent.replaceChildren(
                this.buildPreviewSection('Proposed', data.proposed),
                this.buildPreviewSection('Candidate', data.candidate)
            );
            this.docPreviewModal?.classList.remove('hidden');
            this.docPreviewModal?.classList.add('show');
        } catch (error) {
            console.error('Failed to load example documents:', error);
            alert('Failed to load example documents. Please try again.');
        }
    }

    buildPreviewSection(label, side) {
        const section = document.createElement('div');
        section.className = 'mb-4';

        const heading = document.createElement('h4');
        heading.className = 'font-semibold mb-1';
        heading.textContent = `${label}: "${side.name}"`;
        section.appendChild(heading);

        const list = document.createElement('ul');
        list.className = 'list-disc list-inside';

        if (side.documents.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'text-gray-400';
            empty.textContent = 'No documents found';
            list.appendChild(empty);
        } else {
            side.documents.forEach(doc => {
                const item = document.createElement('li');
                const link = document.createElement('a');
                link.href = doc.link;
                link.target = '_blank';
                link.className = 'text-blue-500 hover:underline';
                link.textContent = doc.title || `Document ${doc.id}`;
                item.appendChild(link);
                list.appendChild(item);
            });
        }

        section.appendChild(list);
        return section;
    }

    hideDocumentPreview() {
        this.docPreviewModal?.classList.remove('show');
        this.docPreviewModal?.classList.add('hidden');
    }

    async previewMerge(button) {
        const id = button.dataset.id;
        try {
            const infoResponse = await fetch(`/api/review/${id}/documents`);
            if (!infoResponse.ok) throw new Error(await extractErrorMessage(infoResponse, 'Merge preview failed'));
            const info = await infoResponse.json();

            this.pendingMergeId = id;
            this.pendingInfo = info;
            // Vorbelegung folgt der Dokumentzahl (3.1/B-3): die Seite mit mehr Dokumenten bleibt
            // standardmaessig erhalten, unabhaengig davon, welche Seite proposed/candidate ist.
            const defaultReverse = info.proposed.documentCount > info.candidate.documentCount;
            await this.loadMergeDirection(defaultReverse);
            this.showModal();
        } catch (error) {
            console.error('Merge preview failed:', error);
            alert(error.message || 'Merge preview failed. Please try again.');
        }
    }

    async loadMergeDirection(reverse) {
        const response = await fetch(`/api/review/${this.pendingMergeId}/merge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
            body: JSON.stringify({ dryRun: true, reverse })
        });
        if (!response.ok) throw new Error(await extractErrorMessage(response, 'Merge preview failed'));
        const preview = await response.json();

        this.pendingReverse = reverse;
        this.pendingDocumentIds = preview.documentIds;
        this.renderMergePreview(preview);
    }

    renderMergePreview(preview) {
        const { proposed, candidate } = this.pendingInfo;
        const [fromSide, toSide] = this.pendingReverse ? [candidate, proposed] : [proposed, candidate];

        this.previewText.textContent = `"${fromSide.name}" (${fromSide.documentCount} document(s)) will be deleted. `
            + `${preview.affectedCount} document(s) will be reassigned to "${toSide.name}" (${toSide.documentCount} document(s)). Continue?`;

        this.previewExamples.replaceChildren(
            this.buildPreviewSection(`Deleted: "${fromSide.name}"`, fromSide),
            this.buildPreviewSection(`Kept: "${toSide.name}"`, toSide)
        );

        if (this.reverseToggle) this.reverseToggle.checked = this.pendingReverse;
    }

    async confirmMerge() {
        if (!this.pendingMergeId) return;
        try {
            const response = await fetch(`/api/review/${this.pendingMergeId}/merge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify({ dryRun: false, documentIds: this.pendingDocumentIds, reverse: this.pendingReverse })
            });
            if (!response.ok) throw new Error(await extractErrorMessage(response, 'Merge failed'));

            document.querySelector(`tr[data-queue-id="${this.pendingMergeId}"]`)?.remove();
            this.hideModal();
        } catch (error) {
            console.error('Merge failed:', error);
            alert(error.message || 'Merge failed. Please try again.');
            this.hideModal();
        }
    }

    async reject(id, button) { // eslint-disable-line no-unused-vars
        // B-5: heute keine Rueckfrage, obwohl die Ablehnung dauerhaft wirkt (Negativ-Cache) -
        // Bulk-Reject fragt bereits nach, die Einzelablehnung bisher nicht.
        if (!confirm('Mark this pair as "not a duplicate"? This is remembered permanently and will not be suggested again.')) {
            return;
        }
        try {
            const response = await fetch(`/api/review/${id}/reject`, { method: 'POST', headers: { 'X-CSRF-Token': getCsrfToken() } });
            if (!response.ok) throw new Error(await extractErrorMessage(response, 'Reject failed'));

            document.querySelector(`tr[data-queue-id="${id}"]`)?.remove();
        } catch (error) {
            console.error('Reject failed:', error);
            alert(error.message || 'Reject failed. Please try again.');
        }
    }

    async backfill(entityType, button) {
        // B-9: der Knopf erklaert heute nicht, dass er alle Paare vergleicht (quadratisch in
        // der Entitaetenzahl) und im Test 16 Eintraege auf einmal erzeugt hat.
        if (!confirm(`Compare every existing ${entityType} pair for near-duplicates? This checks all pairs (quadratic in the entity count) and can add many entries to the review queue.`)) {
            return;
        }
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Running...';
        try {
            const response = await fetch(`/api/review/backfill/${entityType}`, { method: 'POST', headers: { 'X-CSRF-Token': getCsrfToken() } });
            if (!response.ok) throw new Error(await extractErrorMessage(response, 'Backfill scan failed'));
            const result = await response.json();
            alert(`${result.inserted} new entries found.`);
            if (result.inserted > 0) window.location.reload();
        } catch (error) {
            console.error('Backfill scan failed:', error);
            alert('Backfill scan failed. Please try again.');
        } finally {
            button.disabled = false;
            button.textContent = originalText;
        }
    }

    async askJudge(id, button) {
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Asking...';
        try {
            const response = await fetch(`/api/review/${id}/ask-judge`, { method: 'POST', headers: { 'X-CSRF-Token': getCsrfToken() } });
            if (!response.ok) throw new Error(await extractErrorMessage(response, 'Ask judge failed'));
            const result = await response.json();

            const row = document.querySelector(`tr[data-queue-id="${id}"]`);
            const verdictCell = row?.querySelector('.judge-verdict');
            const reasonCell = row?.querySelector('.judge-reason');
            if (verdictCell) verdictCell.textContent = result.verdict;
            if (reasonCell) reasonCell.textContent = result.reason || '';
            button.remove();
        } catch (error) {
            console.error('Ask judge failed:', error);
            alert(error.message || 'Ask judge failed. Please try again.');
            button.disabled = false;
            button.textContent = originalText;
        }
    }

    async bulkReject() {
        const thresholdInput = document.getElementById('bulkRejectThreshold');
        const maxSimilarity = parseFloat(thresholdInput.value);
        if (!Number.isFinite(maxSimilarity) || maxSimilarity < 0 || maxSimilarity > 1) {
            alert('Enter a similarity threshold between 0 and 1.');
            return;
        }

        const params = new URLSearchParams(window.location.search);
        const entityType = params.get('entityType') || null;
        const scope = entityType ? ` (type: ${entityType})` : '';
        if (!confirm(`Reject all open entries with trigram similarity below ${maxSimilarity}${scope}? This cannot be undone.`)) {
            return;
        }

        try {
            const response = await fetch('/api/review/bulk-reject', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                body: JSON.stringify({ entityType, maxSimilarity })
            });
            if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                throw new Error(body.message || 'Bulk reject failed');
            }
            const result = await response.json();
            alert(`${result.rejected} entries rejected.`);
            window.location.reload();
        } catch (error) {
            console.error('Bulk reject failed:', error);
            alert(error.message || 'Bulk reject failed. Please try again.');
        }
    }

    showModal() {
        this.modal?.classList.remove('hidden');
        this.modal?.classList.add('show');
    }

    hideModal() {
        this.modal?.classList.remove('show');
        this.modal?.classList.add('hidden');
        this.pendingMergeId = null;
        this.pendingDocumentIds = null;
        this.pendingReverse = false;
        this.pendingInfo = null;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.themeManager = new ThemeManager();
    window.reviewManager = new ReviewManager();
});

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
        this.confirmBtn = document.getElementById('confirmMerge');
        this.pendingMergeId = null;
        this.initialize();
    }

    initialize() {
        document.querySelectorAll('.merge-btn').forEach(btn => {
            btn.addEventListener('click', () => this.previewMerge(btn.dataset.id));
        });
        document.querySelectorAll('.reject-btn').forEach(btn => {
            btn.addEventListener('click', () => this.reject(btn.dataset.id));
        });
        document.querySelectorAll('.backfill-btn').forEach(btn => {
            btn.addEventListener('click', () => this.backfill(btn.dataset.entityType, btn));
        });

        this.modal?.querySelector('.modal-overlay')?.addEventListener('click', () => this.hideModal());
        this.modal?.querySelector('.modal-close')?.addEventListener('click', () => this.hideModal());
        document.getElementById('cancelMerge')?.addEventListener('click', () => this.hideModal());
        this.confirmBtn?.addEventListener('click', () => this.confirmMerge());
    }

    async previewMerge(id) {
        try {
            const response = await fetch(`/api/review/${id}/merge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dryRun: true })
            });
            if (!response.ok) throw new Error('Vorschau fehlgeschlagen');
            const preview = await response.json();

            this.pendingMergeId = id;
            this.previewText.textContent = `${preview.affectedCount} Dokument(e) werden umgehaengt. Fortfahren?`;
            this.showModal();
        } catch (error) {
            console.error('Merge-Vorschau fehlgeschlagen:', error);
            alert('Merge-Vorschau fehlgeschlagen. Bitte erneut versuchen.');
        }
    }

    async confirmMerge() {
        if (!this.pendingMergeId) return;
        try {
            const response = await fetch(`/api/review/${this.pendingMergeId}/merge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dryRun: false })
            });
            if (!response.ok) throw new Error('Merge fehlgeschlagen');

            document.querySelector(`tr[data-queue-id="${this.pendingMergeId}"]`)?.remove();
            this.hideModal();
        } catch (error) {
            console.error('Merge fehlgeschlagen:', error);
            alert('Merge fehlgeschlagen. Bitte erneut versuchen.');
        }
    }

    async reject(id) {
        try {
            const response = await fetch(`/api/review/${id}/reject`, { method: 'POST' });
            if (!response.ok) throw new Error('Ablehnen fehlgeschlagen');

            document.querySelector(`tr[data-queue-id="${id}"]`)?.remove();
        } catch (error) {
            console.error('Ablehnen fehlgeschlagen:', error);
            alert('Ablehnen fehlgeschlagen. Bitte erneut versuchen.');
        }
    }

    async backfill(entityType, button) {
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Laeuft...';
        try {
            const response = await fetch(`/api/review/backfill/${entityType}`, { method: 'POST' });
            if (!response.ok) throw new Error('Altbestands-Durchlauf fehlgeschlagen');
            const result = await response.json();
            alert(`${result.inserted} neue Eintraege gefunden.`);
            if (result.inserted > 0) window.location.reload();
        } catch (error) {
            console.error('Altbestands-Durchlauf fehlgeschlagen:', error);
            alert('Altbestands-Durchlauf fehlgeschlagen. Bitte erneut versuchen.');
        } finally {
            button.disabled = false;
            button.textContent = originalText;
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
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.themeManager = new ThemeManager();
    window.reviewManager = new ReviewManager();
});

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
            btn.addEventListener('click', () => this.reject(btn.dataset.id));
        });
        document.querySelectorAll('.backfill-btn').forEach(btn => {
            btn.addEventListener('click', () => this.backfill(btn.dataset.entityType, btn));
        });

        this.modal?.querySelector('.modal-overlay')?.addEventListener('click', () => this.hideModal());
        this.modal?.querySelector('.modal-close')?.addEventListener('click', () => this.hideModal());
        document.getElementById('cancelMerge')?.addEventListener('click', () => this.hideModal());
        this.confirmBtn?.addEventListener('click', () => this.confirmMerge());

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
        const proposedName = button.dataset.proposedName;
        const candidateName = button.dataset.candidateName;
        try {
            const response = await fetch(`/api/review/${id}/merge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dryRun: true })
            });
            if (!response.ok) throw new Error('Preview failed');
            const preview = await response.json();

            this.pendingMergeId = id;
            this.previewText.textContent = `"${proposedName}" will be deleted. ${preview.affectedCount} document(s) will be reassigned to "${candidateName}". Continue?`;
            this.showModal();
        } catch (error) {
            console.error('Merge preview failed:', error);
            alert('Merge preview failed. Please try again.');
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
            if (!response.ok) throw new Error('Merge failed');

            document.querySelector(`tr[data-queue-id="${this.pendingMergeId}"]`)?.remove();
            this.hideModal();
        } catch (error) {
            console.error('Merge failed:', error);
            alert('Merge failed. Please try again.');
        }
    }

    async reject(id) {
        try {
            const response = await fetch(`/api/review/${id}/reject`, { method: 'POST' });
            if (!response.ok) throw new Error('Reject failed');

            document.querySelector(`tr[data-queue-id="${id}"]`)?.remove();
        } catch (error) {
            console.error('Reject failed:', error);
            alert('Reject failed. Please try again.');
        }
    }

    async backfill(entityType, button) {
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Running...';
        try {
            const response = await fetch(`/api/review/backfill/${entityType}`, { method: 'POST' });
            if (!response.ok) throw new Error('Backfill scan failed');
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

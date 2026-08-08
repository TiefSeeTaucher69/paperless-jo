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

async function extractErrorMessage(response, fallback) {
    const body = await response.json().catch(() => ({}));
    return body.message || fallback;
}

class AliasManager {
    constructor() {
        document.querySelectorAll('.delete-alias-btn').forEach(btn => {
            btn.addEventListener('click', () => this.deleteAlias(btn.dataset.id, btn));
        });
    }

    async deleteAlias(id, button) {
        const row = document.querySelector(`tr[data-alias-id="${id}"]`);
        const canonicalName = row?.dataset.canonicalName || 'this alias';
        if (!confirm(`Delete the alias pointing to "${canonicalName}"? The next matching pair will go through resolution again.`)) {
            return;
        }

        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Deleting...';
        try {
            const response = await fetch(`/api/review/aliases/${id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': getCsrfToken() } });
            if (!response.ok) throw new Error(await extractErrorMessage(response, 'Delete failed'));

            row?.remove();
        } catch (error) {
            console.error('Delete alias failed:', error);
            alert(error.message || 'Delete failed. Please try again.');
            button.disabled = false;
            button.textContent = originalText;
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.themeManager = new ThemeManager();
    window.aliasManager = new AliasManager();
});

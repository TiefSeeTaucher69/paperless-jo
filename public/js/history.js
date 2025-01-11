// Theme Management
class ThemeManager {
    constructor() {
        this.themeToggle = document.getElementById('themeToggle');
        this.initialize();
    }

    initialize() {
        // Load saved theme or use system preference
        const savedTheme = localStorage.getItem('theme') || 'light';
        this.setTheme(savedTheme);
        
        // Add click event listener
        this.themeToggle.addEventListener('click', () => this.toggleTheme());
    }

    setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
        
        // Update icon
        const icon = this.themeToggle.querySelector('i');
        if (icon) {
            icon.className = theme === 'light' ? 'fas fa-moon' : 'fas fa-sun';
        }
    }

    toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        this.setTheme(newTheme);
    }
}

// History Manager for handling document comparisons and resets
class HistoryManager {
    constructor() {
        this.confirmModal = document.getElementById('confirmModal');
        this.selectAll = document.getElementById('selectAll');
        this.resetSelectedBtn = document.getElementById('resetSelectedBtn');
        this.resetAllBtn = document.getElementById('resetAllBtn');
        this.initialize();
    }

    initialize() {
        this.initializeSelectAll();
        this.initializeResetButton();
        this.initializeResetAllButton();
        this.initializeModalActions();
        this.initializeScrollSync();
        this.initializeRowHighlighting();
        this.highlightDifferences();
    }

    initializeSelectAll() {
        if (this.selectAll) {
            this.selectAll.addEventListener('change', () => {
                document.querySelectorAll('.doc-select').forEach(checkbox => {
                    checkbox.checked = this.selectAll.checked;
                });
            });
        }
    }

    initializeResetButton() {
        if (this.resetSelectedBtn) {
            this.resetSelectedBtn.addEventListener('click', () => {
                const selectedDocs = this.getSelectedDocuments();
                if (selectedDocs.length === 0) {
                    alert('Please select at least one document to reset.');
                    return;
                }
                this.showConfirmModal();
            });
        }
    }

    initializeResetAllButton() {
        if (this.resetAllBtn) {
            this.resetAllBtn.addEventListener('click', () => {
                this.showConfirmModalAll();
            });
        }
    }

    initializeModalActions() {
        // Modal close buttons
        const closeButtons = this.confirmModal.querySelectorAll('#cancelReset, .modal-backdrop');
        closeButtons.forEach(button => {
            button.addEventListener('click', () => this.hideConfirmModal());
        });

        // Confirm reset
        const confirmButton = this.confirmModal.querySelector('#confirmReset');
        if (confirmButton) {
            confirmButton.addEventListener('click', () => {
                const selectedDocs = this.getSelectedDocuments();
                this.resetDocuments(selectedDocs);
            });
        }

        // Close on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.confirmModal.classList.contains('hidden')) {
                this.hideConfirmModal();
            }
        });
    }

    initializeModalActionsAll() {
        // Modal close buttons
        const closeButtons = this.confirmModal.querySelectorAll('#cancelReset, .modal-backdrop');
        closeButtons.forEach(button => {
            button.addEventListener('click', () => this.hideConfirmModal());
        });

        // Confirm reset
        const confirmButton = this.confirmModal.querySelector('#confirmReset');
        if (confirmButton) {
            confirmButton.addEventListener('click', () => {
                const selectedDocs = this.getSelectedDocuments();
                this.resetDocuments(selectedDocs);
            });
        }

        // Close on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.confirmModal.classList.contains('hidden')) {
                this.hideConfirmModal();
            }
        });
    }

    initializeScrollSync() {
        const tableWrappers = document.querySelectorAll('.table-wrapper');
        tableWrappers.forEach(wrapper => {
            wrapper.addEventListener('scroll', () => {
                tableWrappers.forEach(otherWrapper => {
                    if (otherWrapper !== wrapper) {
                        otherWrapper.scrollTop = wrapper.scrollTop;
                    }
                });
            });
        });
    }

    initializeRowHighlighting() {
        document.querySelectorAll('tr[data-index]').forEach(row => {
            row.addEventListener('mouseenter', () => {
                const index = row.dataset.index;
                document.querySelectorAll(`tr[data-index="${index}"]`).forEach(r => {
                    r.classList.add('highlight');
                });
            });
            
            row.addEventListener('mouseleave', () => {
                const index = row.dataset.index;
                document.querySelectorAll(`tr[data-index="${index}"]`).forEach(r => {
                    r.classList.remove('highlight');
                });
            });
        });
    }

    highlightDifferences() {
        const actualRows = document.querySelectorAll('tr[data-index]');
        actualRows.forEach(row => {
            const index = row.dataset.index;
            const originalRow = document.querySelector(`tr[data-index="${index}"]:not(:has(input))`);
            
            if (row && originalRow) {
                // Compare titles
                this.compareElements(
                    row.querySelector('.document-title'), 
                    originalRow.querySelector('.document-title')
                );

                // Compare tags
                this.compareElements(
                    row.querySelector('.tag-container'), 
                    originalRow.querySelector('.tag-container')
                );

                // Compare correspondents
                this.compareElements(
                    row.querySelector('.col-correspondent'), 
                    originalRow.querySelector('.col-correspondent')
                );
            }
        });
    }

    compareElements(actualEl, originalEl) {
        if (actualEl && originalEl) {
            if (actualEl.textContent.trim() !== originalEl.textContent.trim()) {
                actualEl.classList.add('highlight-diff');
            }
        }
    }

    getSelectedDocuments() {
        return Array.from(document.querySelectorAll('.doc-select:checked'))
            .map(checkbox => checkbox.value);
    }

    showConfirmModal() {
        this.confirmModal.classList.remove('hidden');
    }

    hideConfirmModal() {
        this.confirmModal.classList.add('hidden');
    }

    async resetDocuments(ids) {
        try {
            const response = await fetch('/api/reset-documents', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ ids })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || 'Failed to reset documents');
            }

            // Reload page on success
            window.location.reload();
        } catch (error) {
            console.error('Error resetting documents:', error);
            alert('Failed to reset documents. Please try again.');
        } finally {
            this.hideConfirmModal();
        }
    }
}

// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.themeManager = new ThemeManager();
    window.historyManager = new HistoryManager();
});
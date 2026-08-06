/**
 * Service for handling placeholder replacement in prompts
 * Used by all LLM services to ensure consistent placeholder handling
 */
class RestrictionPromptService {
  /**
   * Process placeholders in a prompt by replacing them with actual data
   * @param {string} prompt - The original prompt that may contain placeholders
   * @param {Array} existingTags - Existing tags, as strings or {name} objects
   * @param {Array|string} existingCorrespondentList - Existing correspondents
   * @param {Array} existingDocumentTypes - Existing document types
   * @param {Object} config - Configuration object (unused, kept for compatibility)
   * @returns {string} - Prompt with placeholders replaced
   */
  static processRestrictionsInPrompt(
    prompt,
    existingTags,
    existingCorrespondentList,
    existingDocumentTypes,
    // eslint-disable-next-line no-unused-vars -- config bleibt fuer Aufruf-Kompatibilitaet mit den vier LLM-Services stehen, siehe JSDoc oben ("unused, kept for compatibility").
    config
  ) {
    let processedPrompt = prompt;

    if (processedPrompt.includes('%RESTRICTED_TAGS%')) {
      processedPrompt = processedPrompt.replace(
        /%RESTRICTED_TAGS%/g,
        this._formatNameList(existingTags)
      );
    }

    if (processedPrompt.includes('%RESTRICTED_CORRESPONDENTS%')) {
      processedPrompt = processedPrompt.replace(
        /%RESTRICTED_CORRESPONDENTS%/g,
        this._formatNameList(existingCorrespondentList)
      );
    }

    if (processedPrompt.includes('%RESTRICTED_DOCUMENT_TYPES%')) {
      processedPrompt = processedPrompt.replace(
        /%RESTRICTED_DOCUMENT_TYPES%/g,
        this._formatNameList(existingDocumentTypes)
      );
    }

    return processedPrompt;
  }

  /**
   * Format a list of entities into a comma-separated string.
   * Accepts an array of strings, an array of {name} objects, a mixed array,
   * or an already formatted string.
   * @param {Array|string} list
   * @returns {string} - Comma-separated names, or empty string
   */
  static _formatNameList(list) {
    if (!list) {
      return '';
    }

    if (typeof list === 'string') {
      return list.trim();
    }

    if (!Array.isArray(list)) {
      return '';
    }

    return list
      .filter(Boolean)
      .map(entry => (typeof entry === 'string' ? entry : entry?.name || ''))
      .filter(name => name.length > 0)
      .join(', ');
  }
}

module.exports = RestrictionPromptService;

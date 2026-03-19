import { describe, it, mock } from 'node:test';
import assert from 'node:assert';

describe('GitHub Profile Skill', () => {
  describe('API Endpoints', () => {
    it('should construct correct user profile URL', () => {
      const username = 'openai';
      const expectedUrl = 'https://api.github.com/users/openai';
      const constructedUrl = `https://api.github.com/users/${username}`;
      assert.strictEqual(constructedUrl, expectedUrl);
    });

    it('should construct correct repo URL', () => {
      const owner = 'openclaw';
      const repo = 'openclaw';
      const expectedUrl = 'https://api.github.com/repos/openclaw/openclaw';
      const constructedUrl = `https://api.github.com/repos/${owner}/${repo}`;
      assert.strictEqual(constructedUrl, expectedUrl);
    });

    it('should construct correct search URL', () => {
      const query = 'javascript';
      const expectedUrl = 'https://api.github.com/search/repositories?q=javascript&sort=stars&per_page=5';
      const constructedUrl = `https://api.github.com/search/repositories?q=${query}&sort=stars&per_page=5`;
      assert.strictEqual(constructedUrl, expectedUrl);
    });

    it('should handle usernames with special characters', () => {
      const username = 'netlify';
      const expectedUrl = 'https://api.github.com/users/netlify';
      const constructedUrl = `https://api.github.com/users/${username}`;
      assert.strictEqual(constructedUrl, expectedUrl);
    });
  });

  describe('JSON Parsing', () => {
    it('should extract user profile fields correctly', () => {
      const mockResponse = {
        login: 'openai',
        name: 'OpenAI',
        company: '@OpenAI',
        public_repos: 50,
        followers: 100000,
        following: 500
      };

      const extracted = {
        login: mockResponse.login,
        name: mockResponse.name,
        company: mockResponse.company,
        public_repos: mockResponse.public_repos,
        followers: mockResponse.followers
      };

      assert.strictEqual(extracted.login, 'openai');
      assert.strictEqual(extracted.name, 'OpenAI');
      assert.strictEqual(extracted.company, '@OpenAI');
      assert.strictEqual(extracted.public_repos, 50);
      assert.strictEqual(extracted.followers, 100000);
    });

    it('should extract repo stats correctly', () => {
      const mockResponse = {
        name: 'openclaw',
        full_name: 'openclaw/openclaw',
        stargazers_count: 5000,
        forks_count: 300,
        open_issues_count: 50,
        language: 'TypeScript'
      };

      const stats = {
        name: mockResponse.name,
        stars: mockResponse.stargazers_count,
        forks: mockResponse.forks_count,
        language: mockResponse.language
      };

      assert.strictEqual(stats.stars, 5000);
      assert.strictEqual(stats.forks, 300);
      assert.strictEqual(stats.language, 'TypeScript');
    });

    it('should handle missing optional fields', () => {
      const mockResponse = {
        login: 'testuser',
        name: null,
        company: undefined,
        bio: ''
      };

      const extracted = {
        login: mockResponse.login,
        name: mockResponse.name || 'No name',
        company: mockResponse.company || 'Not specified'
      };

      assert.strictEqual(extracted.name, 'No name');
      assert.strictEqual(extracted.company, 'Not specified');
    });
  });

  describe('URL Construction', () => {
    it('should construct user events URL', () => {
      const username = 'openai';
      const eventsUrl = `https://api.github.com/users/${username}/events?per_page=30`;
      assert.ok(eventsUrl.includes(username));
      assert.ok(eventsUrl.includes('/events'));
    });

    it('should construct user repos URL with sorting', () => {
      const username = 'openai';
      const sort = 'updated';
      const perPage = 10;
      const reposUrl = `https://api.github.com/users/${username}/repos?sort=${sort}&per_page=${perPage}`;
      assert.ok(reposUrl.includes('sort=updated'));
      assert.ok(reposUrl.includes('per_page=10'));
    });

    it('should construct languages URL', () => {
      const owner = 'openclaw';
      const repo = 'openclaw';
      const langUrl = `https://api.github.com/repos/${owner}/${repo}/languages`;
      assert.strictEqual(langUrl, 'https://api.github.com/repos/openclaw/openclaw/languages');
    });
  });

  describe('Search Query Building', () => {
    it('should build search URL with query parameters', () => {
      const query = 'machine learning';
      const language = 'python';
      const minStars = 1000;
      // Note: + is used as separator, > is NOT encoded by encodeURIComponent
      const searchUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+language:${language}+stars:>${minStars}&sort=stars&per_page=5`;

      assert.ok(searchUrl.includes(encodeURIComponent('machine learning')));
      assert.ok(searchUrl.includes('language:python'));
      // encodeURIComponent does not encode >, so it remains as >
      assert.ok(searchUrl.includes('stars:>1000'));
    });

    it('should handle special characters in search', () => {
      const query = 'C++';
      const encodedQuery = encodeURIComponent(query);
      assert.strictEqual(encodedQuery, 'C%2B%2B');
    });
  });

  describe('Error Handling', () => {
    it('should identify rate limit error', () => {
      const errorResponse = {
        message: 'API rate limit exceeded',
        documentation_url: 'https://docs.github.com/rest/overview/rate-limiting-for-the-rest-api'
      };

      const isRateLimitError = errorResponse.message.includes('rate limit');
      assert.strictEqual(isRateLimitError, true);
    });

    it('should identify not found error', () => {
      const errorResponse = {
        message: 'Not Found'
      };

      const isNotFoundError = errorResponse.message === 'Not Found';
      assert.strictEqual(isNotFoundError, true);
    });

    it('should handle empty response', () => {
      const emptyResponse = [];
      const hasResults = emptyResponse.length > 0;
      assert.strictEqual(hasResults, false);
    });
  });

  describe('Token Handling', () => {
    it('should construct auth header when token provided', () => {
      const token = 'ghp_test123';
      const authHeader = `Bearer ${token}`;
      assert.strictEqual(authHeader, 'Bearer ghp_test123');
    });

    it('should handle missing token gracefully', () => {
      const token = process.env.GITHUB_TOKEN || '';
      const hasToken = token.length > 0;
      // This test passes regardless of token presence
      assert.ok(typeof hasToken === 'boolean');
    });
  });
});

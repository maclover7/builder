// The following code is utilized under the MIT License from github.com/nodejs/node-core-utils,
// as copyrighted by "node-core-utils contributors"
// Shout out to @joyeecheung for such an excellent Jenkins API parser!!!!!

const qs = require('querystring');

// constants
const CI_DOMAIN = 'ci.nodejs.org';
const CITGM = 'CITGM';
const PR = 'PR';
const COMMIT = 'COMMIT';
const BENCHMARK = 'BENCHMARK';
const LIBUV = 'LIBUV';
const NOINTL = 'NOINTL';
const V8 = 'V8';
const LINTER = 'LINTER';
const LITE_PR = 'LITE_PR';
const LITE_COMMIT = 'LITE_COMMIT';
const CI_TYPES = new Map([
  [CITGM, { name: 'CITGM', jobName: 'citgm-smoker' }],
  [PR, { name: 'Full PR', jobName: 'node-test-pull-request' }],
  [COMMIT, { name: 'Full Commit', jobName: 'node-test-commit' }],
  [BENCHMARK, {
    name: 'Benchmark',
    jobName: 'benchmark-node-micro-benchmarks'
  }],
  [LIBUV, { name: 'libuv', jobName: 'libuv-test-commit' }],
  [NOINTL, { name: 'No Intl', jobName: 'node-test-commit-nointl' }],
  [V8, { name: 'V8', jobName: 'node-test-commit-v8-linux' }],
  [LINTER, { name: 'Linter', jobName: 'node-test-linter' }],
  [LITE_PR, {
    name: 'Lite PR',
    jobName: 'node-test-pull-request-lite'
  }],
  [LITE_COMMIT, {
    name: 'Lite Commit',
    jobName: 'node-test-commit-lite'
  }]
]);

const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';
const ABORTED = 'ABORTED';
const UNSTABLE = 'UNSTABLE';

const TEST_PHASE = 'Binary Tests';
// com.tikal.jenkins.plugins.multijob.MultiJobBuild
const BUILD_FIELDS = 'buildNumber,jobName,result,url';
const ACTION_TREE = 'actions[parameters[name,value]]';
const CHANGE_FIELDS = 'commitId,author[absoluteUrl,fullName],authorEmail,' +
                      'msg,date';
const CHANGE_TREE = `changeSet[items[${CHANGE_FIELDS}]]`;
const PR_TREE =
  `result,url,number,${ACTION_TREE},${CHANGE_TREE},` +
  `subBuilds[${BUILD_FIELDS},build[subBuilds[${BUILD_FIELDS}]]]`;
const COMMIT_TREE =
  `result,url,number,${ACTION_TREE},${CHANGE_TREE},subBuilds[${BUILD_FIELDS}]`;
// com.tikal.jenkins.plugins.multijob.MultiJobBuild
const FANNED_TREE = `result,url,number,subBuilds[phaseName,${BUILD_FIELDS}]`;
// hudson.matrix.MatrixBuild
const BUILD_TREE = 'result,runs[url,number,result]';
const LINTER_TREE = 'result,url,number';

function getPath(url) {
  return url.replace(`https://${CI_DOMAIN}/`, '').replace('api/json', '');
}

function getUrl(path) {
  return `https://${CI_DOMAIN}/${getPath(path)}`;
}

function resultName(result) {
  return result === null ? 'PENDING' : result.toUpperCase();
}

function fold(summary, code) {
  const dataBlock = '```\n' + code + '\n```';
  const summaryBlock = `\n<summary>${summary}</summary>\n`;
  return `<details>${summaryBlock}\n${dataBlock}\n</details>`;
}

function getNodeName(url) {
  const re = /\/nodes=(.+?)\//;
  if (re.test(url)) {
    return url.match(re)[1];
  }
  const parts = url.split('/');
  return parts[parts.length - 3];
}

function flatten(arr) {
  let result = [];
  for (const item of arr) {
    if (Array.isArray(item)) {
      result = result.concat(flatten(item));
    } else {
      result.push(item);
    }
  }
  return result;
}

class Job {
  constructor(request, path, tree) {
    this.request = request;
    this.path = path;
    this.tree = tree;
  }

  get jobUrl() {
    const { path } = this;
    return `https://${CI_DOMAIN}/${path}`;
  }

  get apiUrl() {
    const { tree } = this;
    const query = tree ? `?tree=${qs.escape(tree)}` : '';
    return `${this.jobUrl}api/json${query}`;
  }

  get consoleUrl() {
    const { path } = this;
    return `https://${CI_DOMAIN}/${path}consoleText`;
  }

  get consoleUIUrl() {
    const { path } = this;
    return `https://${CI_DOMAIN}/${path}console`;
  }

  async getBuildData() {
    const { path } = this;
    const data = await this.getAPIData();
    return data;
  }

  async getAPIData() {
    const { request, path } = this;
    const url = this.apiUrl;
    return request.json(url);
  }

  async getConsoleText() {
    const { request, path } = this;
    const data = await request.text(this.consoleUrl);
    return data.replace(/\r/g, '');
  }
}

class CommitBuild extends Job {
  constructor(request, id) {
    const path = `job/node-test-commit/${id}/`;
    const tree = COMMIT_TREE;
    super(request, path, tree);

    this.result = null;
    this.builds = {};
    this.failures = [];
    this.params = {};
    this.change = {};
    this.date = undefined;
  }

  getBuilds({result, subBuilds, changeSet, actions, timestamp}) {
    if (result === SUCCESS) {
      return { result: SUCCESS };
    }

    const allBuilds = subBuilds;
    const failed = allBuilds.filter(build => build.result === FAILURE);
    const aborted = allBuilds.filter(build => build.result === ABORTED);
    const pending = allBuilds.filter(build => build.result === null);
    const unstable = allBuilds.filter(build => build.result === UNSTABLE);

    //
    const params = actions.find(item => typeof item.parameters === 'object');
    params.parameters.forEach(pair => {
      this.params[pair.name] = pair.value;
    });

    this.change = changeSet.items[0];
    this.date = new Date(timestamp);

    // build: { buildNumber, jobName, result, url }
    this.result = result;
    const builds = this.builds = { failed, aborted, pending, unstable };
    return { result, builds };
  }

  // Get the failures and their reasons of this build
  async getResults(data) {
    const { path, request } = this;
    if (!data) {
      data = await this.getBuildData();
    }
    const { result, builds } = this.getBuilds(data);
    if (result === SUCCESS || !builds.failed.length) {
      return { result };
    }

    const promises = builds.failed.map(({jobName, buildNumber}) => {
      if (jobName.includes('fanned')) {
        return new FannedBuild(request, jobName, buildNumber).getResults();
      } else if (jobName.includes('linter')) {
        return new LinterBuild(request, jobName, buildNumber).getResults();
      }
      return new NormalBuild(request, jobName, buildNumber).getResults();
    });
    const rawFailures = await Promise.all(promises);

    // failure: { url, reason }
    const failures = this.failures = flatten(rawFailures);
    return { result, failures, builds, commit: this.commit };
  }

  get commit() {
    const { change, params } = this;
    var owner, repo;

    if (params.PR_ID) {  // from a node-test-pull-request build
      owner = params.TARGET_GITHUB_ORG;
      repo = params.TARGET_REPO_NAME;
    }

    if (params.GITHUB_ORG) {  // from a node-test-commit build
      owner = params.GITHUB_ORG;
      repo = params.REPO_NAME;
    }

    return `<a href="https://github.com/${owner}/${repo}/commit/${change.commitId}">[${change.commitId.slice(0, 7)}]</a> ${change.msg}`;
  }
}

class PRBuild extends Job {
  constructor(request, id) {
    const path = `job/node-test-pull-request/${id}/`;
    const tree = PR_TREE;
    super(request, path, tree);

    this.commitBuild = null;
  }

  // Get the failures and their reasons of this build
  async getResults() {
    const { request } = this;
    const data = await this.getBuildData();
    const {
      result, subBuilds, changeSet, actions, timestamp
    } = data;

    const commitBuild = subBuilds[0];
    // assert.strictEqual(commitBuild.jobName, 'node-test-commit');
    const allBuilds = commitBuild.build.subBuilds;
    const buildData = {
      result, subBuilds: allBuilds, changeSet, actions, timestamp
    };
    const commitBuildId = commitBuild.buildNumber;
    this.commitBuild = new CommitBuild(request, commitBuildId);
    return this.commitBuild.getResults(buildData);
  }
}

class FannedBuild extends Job {
  constructor(request, jobName, id) {
    // assert(jobName.includes('fanned'));
    const path = `job/${jobName}/${id}/`;
    const tree = FANNED_TREE;
    super(request, path, tree);

    this.failures = [];
  }

  // Get the failures and their reasons of this build
  async getResults() {
    const { request } = this;
    const data = await this.getAPIData();
    const test = data.subBuilds.find(build => build.phaseName === TEST_PHASE);

    if (!test) {
      this.failures = [{ url: this.jobUrl, reason: 'No test phase' }];
      return this.failures;
    }

    if (test.result === SUCCESS) {
      this.failures = [];
      return this.failures;
    }

    if (test.result !== FAILURE) {
      this.failures = [{
        url: this.jobUrl,
        reason: `Result: ${resultName(test.result)}`
      }];
      return this.failures;
    }

    const { jobName, buildNumber } = test;
    const build = new NormalBuild(request, jobName, buildNumber);
    const failures = await build.getResults();
    this.failures = flatten(failures);
    return this.failures;
  }
}

class LinterBuild extends Job {
  constructor(request, jobName, id) {
    const path = `job/${jobName}/${id}/`;
    const tree = LINTER_TREE;
    super(request, path, tree);

    this.failures = [];
  }

  async getResults() {
    const data = await this.getConsoleText();
    for (const pattern of FAILURE_PATTERNS) {
      const results = data.match(pattern.pattern);
      if (results) {
        const failures = pattern.filter.call(this, results, data);
        this.failures = failures;
        return failures;
      }
    }

    this.failures = [{
      url: this.jobUrl,
      reason: 'Unknown'
    }];
    return this.failures;
  }
}

class NormalBuild extends Job {
  constructor(request, jobName, id) {
    const path = `job/${jobName}/${id}/`;
    const tree = BUILD_TREE;
    super(request, path, tree);

    this.failures = [];
  }

  async getResults() {
    const { request } = this;
    const { result, runs } = await this.getAPIData();
    if (result === SUCCESS) {
      this.failures = [];
      return this.failures;
    }
    if (result !== FAILURE) {
      this.failures = [{
        url: this.jobUrl,
        reason: `Result: ${resultName(result)}`
      }];

      return this.failures;
    }
    const failed = runs.filter(run => run.result === FAILURE);
    const promises = failed.map(
      ({ url }) => new TestRun(request, url).getResults()
    );
    const failures = await Promise.all(promises);
    this.failures = flatten(failures);
    return this.failures;
  }
}

function unique(arr) {
  return Array.from(new Set(arr).values());
}

function filterTapReasons(matches, data) {
  const nonFlaky = matches.filter((m) => !m.includes('# TODO :'));
  return dedupReasons.call(this, nonFlaky, data);
}

function dedupReasons(matches, data) {
  return unique(matches).map(match => ({
    url: this.consoleUIUrl,
    reason: match
  }));
}

function mergeReasons(matches, data) {
  return [{
    url: this.consoleUIUrl,
    reason: unique(matches).join('\n')
  }];
}

function pickReason(index = 0, contextBefore = 0, contextAfter = 0) {
  return function(matches, data) {
    if (index < 0) { index = matches.length + index; }
    const match = matches[index];
    const offset = data.indexOf(match);
    let after = offset + match.length;
    for (let i = 0; i < contextAfter; ++i) {
      const next = data.indexOf('\n', after + 1);
      after = next > 0 ? next : after;
    }
    let before = offset;
    for (let i = 0; i < contextBefore; ++i) {
      const next = data.lastIndexOf('\n', before - 1);
      before = next > 0 ? next : before;
    }
    return [{
      url: this.consoleUIUrl,
      reason: data.slice(before, after)
    }];
  };
}

const FAILURE_PATTERNS = [{
  pattern: /not ok[\s\S]+? {2}\.\.\.\r?\n/mg,
  filter: filterTapReasons,
  name: 'js test failure'
}, {
  pattern: /\[ {2}FAILED {2}\].+/g,
  filter: pickReason(0, 5, 0),
  name: 'cctest failure'
}, {
  pattern: /java\.io\.IOException.+/g,
  filter: pickReason(-1, 0, 5),
  name: 'infra issue'
}, {
  pattern: /ERROR: .+/g,
  filter: pickReason(-1, 0, 5),
  name: 'build failure'
}, {
  pattern: /Error: .+/g,
  filter: pickReason(0, 0, 5),
  name: 'tool error'
}, {
  pattern: /fatal: .+/g,
  filter: mergeReasons,
  name: 'build failure'
}, {
  pattern: /FATAL: .+/g,
  filter: pickReason(-1, 0, 5),
  name: 'build failure'
}, {
  pattern: /error: .+/g,
  filter: pickReason(0, 0, 5),
  name: 'build failure'
}, {
  pattern: /make.*: write error/mg,
  filter: pickReason(0, 0, 3),
  name: 'build failure'
}, {
  pattern: /Makefile:.+failed/g,
  filter: pickReason(0, 0, 5),
  name: 'build failure'
}, {
  pattern: /make.*: .+ Error \d.*/g,
  filter: pickReason(0, 0, 3),
  name: 'build failure'
}, {
  pattern: /warning: failed .+/g,
  filter: pickReason(0, 0, 3),
  name: 'build failure'
}];

class TestRun extends Job {
  constructor(request, url) {
    const path = getPath(url);
    super(request, path);

    this.failures = [];
  }

  async getResults() {
    const data = await this.getConsoleText();
    for (const pattern of FAILURE_PATTERNS) {
      const results = data.match(pattern.pattern);
      if (results) {
        const failures = pattern.filter.call(this, results, data);
        this.failures = failures;
        return failures;
      }
    }

    this.failures = [{
      url: this.jobUrl,
      reason: 'Unknown'
    }];
    return this.failures;
  }
}

class BenchmarkRun extends Job {
  constructor(request, id) {
    const path = `job/benchmark-node-micro-benchmarks/${id}/`;
    super(request, path);

    this.results = '';
    this.significantResults = '';
    this.params = {};
  }

  async getResults() {
    const data = await this.getBuildData();
    const params = data.actions.find(item => typeof item.parameters === 'object');
    params.parameters.forEach(pair => {
      this.params[pair.name] = pair.value;
    });

    const { path } = this;
    const text = await this.getConsoleText();
    const index = text.indexOf('improvement');
    if (index === -1) {
      throw new Error('Not finished');
    }
    const breakIndex = text.lastIndexOf('\n', index);
    const results = text.slice(breakIndex + 1)
      .replace(/\nSending e-mails[\s\S]+/mg, '');
    this.results = results;
    this.significantResults = this.getSignificantResults(results);
    return { results, params: this.params };
  }

  getSignificantResults(data) {
    const lines = data.split('\n');
    const significant = lines.filter(line => line.indexOf('*') !== -1);
    return significant.slice(0, -3).join('\n');
  }

  appendToMarkdown(file) {
    const { results, significantResults } = this;
    const output = (fold('Benchmark results', results) + '\n\n' +
                    fold('Significant impact', significantResults) + '\n');

    console.log(output);
  }
}

const getCIBuildResults = (jobType, jobId, request) => {
  if (jobType === 'node-test-pull-request') {
    build = new PRBuild(request, jobId);
  } else if (jobType === 'node-test-commit') {
    build = new CommitBuild(request, jobId);
  } else if (jobType === 'benchmark-node-micro-benchmarks') {
    build = new BenchmarkRun(request, jobId);
  }

  return build.getResults();
};

module.exports = {
  getCIBuildResults,
};

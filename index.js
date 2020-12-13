const core = require("@actions/core");
const github = require("@actions/github");
const util = require("util");
const exec = util.promisify(require("child_process").exec);

const { context } = github;

const COMMENT_HEADER = "## Flow Coverage\n";

async function getFilesInPR(octokit, pattern) {
  const res = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
    {
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.payload.pull_request.number,
    }
  );
  if (res.status !== 200) {
    throw "Cannot find PR";
  }
  return res.data
    .map(({ filename, status }) => {
      return {
        filename,
        status,
      };
    })
    .filter(({ filename }) => {
      const regex = new RegExp(pattern, "gmi");
      return regex.test(filename);
    });
}

async function getCoverageData(directory, path, filenames, packageManager) {
  const outputs = await Promise.all(
    filenames.map((filename) => {
      let extendedDirectory = directory;
      let clippedFilename = filename;
      if (path !== "") {
        extendedDirectory += `/${path}`;
        const regex = new RegExp("^(" + path + ")");
        clippedFilename = filename.replace(regex, "");
      }
      return exec(
        `cd ${extendedDirectory} && ${packageManager} flow coverage ${clippedFilename} --quiet`
      );
    })
  );

  const coverageData = {};
  outputs.forEach(async ({ stdout, stderr }, index) => {
    const begin = stdout.indexOf(": ") + 2;
    const end = stdout.indexOf("%");
    coverageData[filenames[index]] = stdout.substring(begin, end);
  });

  return coverageData;
}

function getMarkdownTableAndThresholdPass(coverageDifference, threshold) {
  const floatThreshold = parseFloat(threshold);
  let passesThreshold = true;
  let table = "| File | Difference |\n| --- | --- |";
  Object.keys(coverageDifference).forEach((filename) => {
    if (isNaN(coverageDifference[filename])) {
      table += `\n| ${filename} | ${coverageDifference[filename]}`;
    } else {
      const roundedDifference =
        Math.round(
          (parseFloat(coverageDifference[filename]) + Number.EPSILON) * 100
        ) / 100;
      passesThreshold =
        passesThreshold &&
        !isNaN(floatThreshold) &&
        Math.sign(roundedDifference) === -1
          ? roundedDifference > -Math.abs(threshold)
          : passesThreshold;
      let differenceString = roundedDifference.toString();
      if (differenceString.charAt(0) !== "-") {
        differenceString = "+" + differenceString;
      }
      table += `\n| ${filename} | ${differenceString}%`;
    }
  });

  return { table, passesThreshold };
}

async function run() {
  const pattern = core.getInput("pattern");
  const myToken = core.getInput("github-token");
  const octokit = github.getOctokit(myToken);
  const filenamesInPR = await getFilesInPR(octokit, pattern);
  if (filenamesInPR.length === 0) {
    return;
  }

  const modifiedFiles = filenamesInPR
    .filter(({ filename, status }) => status === "modified")
    .map(({ filename }) => filename);
  const packageManager = core.getInput("package-manager");
  const path = core.getInput("path");
  const prCoverageData = await getCoverageData(
    "head",
    path,
    modifiedFiles,
    packageManager
  );
  const baseCoverageData = await getCoverageData(
    "base",
    path,
    modifiedFiles,
    packageManager
  );

  const coverageDifference = {};
  modifiedFiles.forEach((filename) => {
    coverageDifference[filename] = (
      prCoverageData[filename] - baseCoverageData[filename]
    ).toString();
  });
  filenamesInPR.forEach(({ filename, status }) => {
    if (status !== "modified") {
      coverageDifference[filename] = status;
    }
  });

  const threshold = core.getInput("threshold");
  const { table, passesThreshold } = getMarkdownTableAndThresholdPass(
    coverageDifference,
    threshold
  );

  await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.payload.pull_request.number,
      body: COMMENT_HEADER + table,
    }
  );

  if (passesThreshold === false) {
    core.setFailed(`A file does not pass the flow threshold of ${threshold}`);
  }
}

try {
  run();
} catch (error) {
  core.setFailed(error.message);
}

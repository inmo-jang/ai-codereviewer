import { Octokit } from '@octokit/rest';
import * as core from '@actions/core';
import { ReviewResponse } from '../providers/AIProvider';

export interface PRDetails {
  owner: string;
  repo: string;
  number: number;
  title: string;
  description: string;
  base: string;
  head: string;
}

export class GitHubService {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
    [this.owner, this.repo] = (process.env.GITHUB_REPOSITORY ?? '/').split('/');
  }

  async getPRDetails(prNumber: number): Promise<PRDetails> {
    const { data: pr } = await this.octokit.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });

    return {
      owner: this.owner,
      repo: this.repo,
      number: prNumber,
      title: pr.title,
      description: pr.body ?? '',
      base: pr.base.sha,
      head: pr.head.sha,
    };
  }

  async getFileContent(path: string, ref?: string): Promise<string> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ref,
      });

      if ('content' in data) {
        return Buffer.from(data.content, 'base64').toString();
      }
      throw new Error('Not a file');
    } catch (error) {
      core.warning(`Failed to get content for ${path}: ${error}`);
      return '';
    }
  }

  async submitReview(prNumber: number, review: ReviewResponse) {
    const { summary, lineComments = [], suggestedAction } = review;

    // Convert line comments to GitHub review comments format
    // const allComments = await Promise.all(lineComments.map(async comment => {
    //   try {
    //     return {
    //       path: comment.path,
    //       side: 'RIGHT', // For new file version
    //       line: comment.line, // The actual line number
    //       body: comment.comment
    //     };
    //   } catch (error) {
    //     core.warning(`Skipping comment for ${comment.path}:${comment.line} - ${error}`);
    //     return null;
    //   }
    // }));

    // const comments = allComments.filter(comment => comment !== null);

    // core.info(`Submitting review with ${comments.length} comments`);
    // core.debug(`Review comments: ${JSON.stringify(comments, null, 2)}`);

    // await this.octokit.pulls.createReview({
    //   owner: this.owner,
    //   repo: this.repo,
    //   pull_number: prNumber,
    //   body: summary,
    //   comments,
    //   event: suggestedAction.toUpperCase() as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
    // });

    // Step 1: Create an initial review with the summary only
    let reviewId: number | null = null;
    try {
      const initialReview = await this.octokit.pulls.createReview({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        body: summary,
        event: suggestedAction.toUpperCase() as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
      });
      reviewId = initialReview.data.id; // Store the review ID for adding comments later
      core.info(`Initial review created with ID: ${reviewId}`);
    } catch (error: unknown) {
      core.error(`Failed to create initial review: ${(error as Error).message}`);
      throw error; // Exit if summary review creation fails
    }


    // Step 2: Add individual comments to the review
    const { data: pull } = await this.octokit.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });
    const commitId = pull.head.sha;

    for (const comment of lineComments) {
      try {
        await this.octokit.pulls.createReviewComment({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
          body: comment.comment,
          commit_id: commitId,          
          path: comment.path,
          side: 'RIGHT', // For new file version
          line: comment.line, // The actual line number
        });
        core.info(`Comment added for ${comment.path}:${comment.line}`);
      } catch (error: unknown) {
        core.warning(`Skipping comment for ${comment.path}:${comment.line} - ${(error as Error).message}`);
      }
    }

    core.info("Review submission completed.");

  }

  /**
   * This is a hack to get the position of a line in the diff.
   * It's not perfect, but it's better than nothing.
   * It's based on the patch file, which is not always available.
   * It's also not always accurate, but it's better than nothing.
   *
   * @deprecated
   */
  private async getDiffPosition(prNumber: number, filePath: string, line: number): Promise<number> {
    const { data: files } = await this.octokit.pulls.listFiles({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber
    });

    const file = files.find(f => f.filename === filePath);
    if (!file) {
      throw new Error(`File ${filePath} not found in PR diff`);
    }

    const patch = file.patch || '';
    let position = 0;
    let oldLine = 0;
    let newLine = 0;

    for (const patchLine of patch.split('\n')) {
      if (patchLine.startsWith('@@')) {
        const match = patchLine.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match) {
          oldLine = parseInt(match[1], 10) - 1;
          newLine = parseInt(match[2], 10) - 1;
        }
        continue;
      }

      position++;

      if (patchLine.startsWith('-')) {
        oldLine++;
        if (oldLine === line) {
          return position;
        }
      } else if (patchLine.startsWith('+')) {
        newLine++;
        if (newLine === line) {
          return position;
        }
      } else {
        oldLine++;
        newLine++;
        if (newLine === line || oldLine === line) {
          return position;
        }
      }
    }

    core.error(`Failed to find line ${line} in diff. Last old line: ${oldLine}, last new line: ${newLine}`);
    throw new Error(`Line ${line} not found in diff for ${filePath}`);
  }

  async getLastReviewedCommit(prNumber: number): Promise<string | null> {
    const { data: reviews } = await this.octokit.pulls.listReviews({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });

    // Find the last review from our bot
    const lastBotReview = reviews
      .reverse()
      .find(review => review.user?.login === 'github-actions[bot]');

    if (!lastBotReview) return null;

    // Get the commit SHA at the time of the review
    const { data: commits } = await this.octokit.pulls.listCommits({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });

    const reviewDate = new Date(lastBotReview.submitted_at!);
    const lastCommit = commits
      .reverse()
      .find(commit => commit.commit.committer?.date &&
        new Date(commit.commit.committer.date) <= reviewDate);

    return lastCommit?.sha || null;
  }

  async getPreviousReviews(prNumber: number): Promise<Array<{
    commit: string | null;
    summary: string;
    lineComments: Array<{
      path: string;
      line: number;
      comment: string;
    }>;
  }>> {
    const { data: reviews } = await this.octokit.pulls.listReviews({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });

    // Filter to bot reviews and fetch their comments
    const botReviews =reviews.filter(review => review.user?.login === 'github-actions[bot]');

    core.debug(`Found ${botReviews.length} bot reviews`);

    const botReviewsWithComments = await Promise.all(
      botReviews.map(async review => {
        const { data: comments } = await this.octokit.pulls.listReviewComments({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
          review_id: review.id
          });

          return {
            commit: review.commit_id,
            summary: review.body || '',
            lineComments: comments.map(comment => ({
              path: comment.path,
              line: comment.line || 0,
              comment: comment.body
            }))
          };
        })
    );

    return botReviewsWithComments;
  }
}

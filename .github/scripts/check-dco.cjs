module.exports = async ({ github, context, core, exec }) => {
    const pullRequest = context.payload.pull_request;
    const username = pullRequest.user?.login;
    let permission;
    let roleName;
    if (username) {
        try {
            const { data } = await github.request("GET /repos/{owner}/{repo}/collaborators/{username}/permission", {
                ...context.repo,
                username,
                headers: { "X-GitHub-Api-Version": "2026-03-10" },
            });
            permission = data.permission;
            roleName = data.role_name;
        } catch (error) {
            core.warning(
                `Repository permissions for ${username} could not be verified (HTTP ${error.status ?? "unknown"}); ` +
                    "requiring commit sign-offs.",
            );
        }
    }
    if (["write", "admin"].includes(permission)) {
        core.info(`${username}: repository permission ${permission}; automatic DCO checking is not required.`);
        return;
    }

    core.info(
        `Requiring commit sign-offs: PR author repository permission ${permission ?? "unknown"} is not write or admin.`,
    );
    const commits = await github.paginate(github.rest.pulls.listCommits, {
        ...context.repo,
        pull_number: pullRequest.number,
        per_page: 100,
    });
    if (commits.length !== pullRequest.commits) {
        core.setFailed(
            `Expected ${pullRequest.commits} commits but received ${commits.length}. ` +
                "GitHub's pull-request commits API supports at most 250 commits; " +
                "split larger pull requests or rerun if the branch changed during the check.",
        );
        return;
    }
    if (commits.at(-1)?.sha !== pullRequest.head.sha) {
        core.setFailed("The pull request changed during the check. Rerun against the latest commits.");
        return;
    }

    const failures = [];
    for (const { sha, commit } of commits) {
        const author = commit.author;
        const expected = author?.name && author?.email ? `Signed-off-by: ${author.name} <${author.email}>` : undefined;
        const { stdout } = await exec.getExecOutput("git", ["interpret-trailers", "--parse"], {
            input: commit.message,
            silent: true,
            cwd: process.env.RUNNER_TEMP,
        });
        const signedOff =
            expected && stdout.split(/\r?\n/).some((trailer) => trailer.toLowerCase() === expected.toLowerCase());
        if (!signedOff) {
            failures.push({ sha, expected });
            core.error(`${sha}: missing author sign-off${expected ? `; expected "${expected}"` : ""}.`);
        }
    }
    if (failures.length > 0) {
        const escapeHtml = (value) =>
            value
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;")
                .replaceAll('"', "&quot;")
                .replaceAll("'", "&#39;");
        await core.summary
            .addHeading("DCO sign-offs required")
            .addTable([
                [
                    { data: "Commit", header: true },
                    { data: "Expected trailer", header: true },
                ],
                ...failures.map(({ sha, expected }) => [
                    `<code>${escapeHtml(sha)}</code>`,
                    `<code>${escapeHtml(expected ?? "Missing commit author name or email")}</code>`,
                ]),
            ])
            .addRaw("Sign off your commits with <code>git commit -s</code>; see CONTRIBUTING.md.", true)
            .write();
        core.setFailed(
            `${failures.length} commit(s) lack a matching Signed-off-by trailer. ` +
                "Sign off your commits with git commit -s; see CONTRIBUTING.md.",
        );
    } else {
        core.info(`All ${commits.length} commits have matching author sign-offs.`);
    }
};

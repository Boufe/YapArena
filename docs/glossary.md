# Glossary

These terms appear throughout the repository documentation. The definitions describe how this
template uses them.

- **API:** the HTTP service that receives requests and returns responses. This project's API listens
  on <http://localhost:3000> by default.
- **Alertmanager:** a Prometheus companion service that routes alerts to destinations such as email or
  paging systems. This template's local stack displays alert state but does not include Alertmanager.
- **Artifact:** a built output, such as a container image, that can be stored and deployed.
- **CI (continuous integration):** automated checks that GitHub runs after code is pushed or proposed
  in a pull request. In `npm ci`, however, `ci` is npm's name for a clean, lockfile-based install.
- **Container:** an isolated running process created from an image. PostgreSQL and the production-like
  application run in containers locally.
- **Container image:** the packaged filesystem and instructions used to create a container. Building an
  image does not start it; `docker compose up` creates and starts containers from images.
- **Database migration:** a versioned source file that changes database structure, such as creating a
  table or adding a column. Applied migrations become part of the database's history.
- **Dependency:** external code used by the project. Direct dependencies are listed in `package.json`;
  exact direct and transitive versions are recorded in `package-lock.json`.
- **Digest:** an immutable cryptographic identifier such as `sha256:...` for exact image contents.
  Unlike a tag, a digest cannot be moved to different image contents.
- **Docker Compose:** the tool that reads `compose.yaml` and manages this project's related containers,
  networks, environment settings, and persistent volumes as one stack.
- **Environment variable:** a named runtime setting such as `DATABASE_URL` or `PORT`. For local work,
  this project loads values from `.env`; production secrets require protected storage.
- **GHCR (GitHub Container Registry):** GitHub's service for storing and distributing container images.
- **Grafana:** the optional local web interface that displays this service's Prometheus metrics in
  dashboards.
- **Git branch:** a movable line of development. Feature branches keep work separate from `main` until
  it is reviewed and merged.
- **Git remote:** a saved address for another Git repository. `git clone` normally names the cloned
  GitHub repository `origin`.
- **Health check:** an automated request or command that determines whether a service is functioning.
  `/health` checks the API process; `/ready` also checks database availability.
- **Lockfile:** `package-lock.json`, which records exact dependency versions, download locations, and
  integrity hashes so installations are reproducible.
- **Observability:** logs, metrics, traces, and related tools used to understand a running service.
- **OCI:** a set of open container image and runtime standards. Docker-compatible images published by
  this template are OCI artifacts.
- **Origin:** in HTTP security, the scheme, host, and optional port of a site, such as
  `https://service.example.com`. This is unrelated to the Git remote named `origin`.
- **PR (pull request):** a GitHub proposal to review and merge changes from one branch into another.
- **Prometheus:** the optional monitoring service that regularly collects numeric metrics from the API
  and evaluates alert rules.
- **Provenance:** signed or verifiable metadata describing where and how an artifact was built.
- **Reverse proxy:** a server in front of the application that receives public traffic, usually handles
  TLS/HTTPS, and forwards requests to the application.
- **SBOM (software bill of materials):** an inventory of packages and components included in a built
  artifact.
- **Secret:** a sensitive value such as a production password, token, or private key. Secrets must not
  be committed to Git.
- **Semantic version:** a release number in `MAJOR.MINOR.PATCH` form, such as `1.4.2`, where each part
  communicates a category of compatibility or change.
- **Volume:** Docker-managed persistent storage. Removing a container does not remove its named volume;
  `docker compose down --volumes` does.

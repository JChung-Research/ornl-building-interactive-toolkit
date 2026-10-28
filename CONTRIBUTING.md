# Contributing to ORBIT

Thanks for your interest in contributing! This document explains how to propose changes.

## License of contributions (inbound = outbound)

By submitting a contribution (pull request, patch, or any other form), you agree that your contribution is licensed under the **Apache License, Version 2.0**, the same license that covers this project — see [`LICENSE`](LICENSE). 

You represent that you are legally entitled to submit the contribution under this license.

## Attribution rules (important for this repository)

This codebase is a **derivative of PNNL's Apache-2.0 `volttron-pnnl-aems`**. When contributing, please:

- **Do not remove or alter** existing `Copyright … Battelle Memorial Institute` headers or other upstream notices (required by Apache-2.0 §4(c)).
- **Mark modified files** as changed (Apache-2.0 §4(b)).
- For **new files**, add an SPDX header:
  ```
  # Copyright <YEAR> UT-Battelle, LLC
  # SPDX-License-Identifier: Apache-2.0
  ```
- For **files you modify** that already carry the Battelle header, keep it and add:
  ```
  # Modifications Copyright <YEAR> UT-Battelle, LLC
  # SPDX-License-Identifier: Apache-2.0
  ```

Replace `<YEAR>` with the year you create (or modify) the file.

See [`NOTICE`](NOTICE) for full provenance.

## How to contribute

1. Open an issue describing the bug or proposed change before large work.
2. Fork and create a feature branch.
3. Keep changes focused; include tests where applicable.
4. Run the relevant linters/tests:
   - Web: `cd web-app/web-server && yarn test`  ·  `cd web-app/web-client && yarn test`
5. Do **not** commit secrets, real `.env` files, private keys, certificates, license files (`*.lic`), or large/generated artifacts. Verify with `git status` / `git add -n` before committing.
6. Open a pull request that summarizes the change and references the issue.

## Questions

Open an issue or contact the maintainers (Jihoon Chung / chungj2@ornl.gov)
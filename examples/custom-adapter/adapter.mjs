import { referenceAdapter } from "synclab/adapters/reference";

// A custom adapter is an AdapterFactory. This small example delegates the wire
// format and storage behavior to SyncLab's reference model while giving it a
// distinct manifest. Real adapters can return their own AdapterClient objects.
export default {
  name: "example-custom-reference",
  version: "1.0.0",
  async create(options) {
    return referenceAdapter.create(options);
  },
};

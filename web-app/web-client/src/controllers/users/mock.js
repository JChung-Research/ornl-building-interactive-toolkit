import { SERVICE_ENDPOINT_CREATE_USER } from "./api";

const mock = {
  [SERVICE_ENDPOINT_CREATE_USER]: {
    payload: {
      email: "demo@example.com",
      password: "password",
      firstName: "demo",
      lastName: "demo",
      organization: "pnnl",
    },
    result: {
      id: 1,
      email: "demo@example.com",
      firstName: "demo",
      lastName: "demo",
      organization: "pnnl",
    },
  },
};

export default mock;

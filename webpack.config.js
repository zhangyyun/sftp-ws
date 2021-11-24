const path = require('path');
module.exports = {
  mode: 'production',
  entry: './out/client.js',
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.js$/,
        use: ["source-map-loader"],
        enforce: "pre",
        exclude: /node_modules/
      },
    ],
  },
  resolve: {
    modules: ['./node_modules'],
    extensions: ['.js'],
  },
  output: {
    filename: 'sftp_client.js',
    path: path.resolve(__dirname, 'lib'),
    libraryTarget: 'umd'
  },
};

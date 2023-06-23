// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import '../App.css';
import { useState } from 'react';
import axios from 'axios';

let apiEndpointConfig = require('./api_endpoint.json');

const Homepage = ({ user, signOut }) => {

  const [selectedFile, setSelectedFile] = useState(null)
  const [fileUploadedSuccessfully, setFileUploadedSuccessfully] = useState(false)
  const [bucketFiles, setBucketFiles] = useState(null)
  const [searchString, setSearchString] = useState(null)
  const [searchResult, setSearchResult] = useState(null)
  const [searchCount, setSearchCount] = useState(0);


  const presingedEndpointURL = new URL(apiEndpointConfig.presignedResource.substring(1), apiEndpointConfig.apiEndpoint).toString();
  const listDocsEndpointURL = new URL(apiEndpointConfig.listDocsResource.substring(1), apiEndpointConfig.apiEndpoint).toString();
  const searchDocsEndpointURL = new URL(apiEndpointConfig.searchDocsResource.substring(1), apiEndpointConfig.apiEndpoint).toString();

  const onFileChange = event => {
    setSelectedFile(event.target.files[0]);
  }

  const onFileUpload = () => {

    const file = selectedFile;
    const fileName = selectedFile.name;
    let fileType = selectedFile.type;

    // set default MIME type if undefined
    if (!fileType) {
      fileType = "application/octet-stream";
    }

    let Token = user.signInUserSession.idToken.jwtToken;
    const config = {
      headers: { Authorization: Token }
    };

    const bodyParameters = {
      fileName: fileName,
      fileType: fileType
    };

    //call the API GW to generate the s3 presigned url to upload the file
    axios.post(presingedEndpointURL, bodyParameters, config).then((r) => {
      //upload the file to s3 with the returned presigned url and tag the object
      axios.put(r.data.preSignedUrl, file, { headers: { 'Content-Type': fileType, 'x-amz-tagging': `${r.data.tagKey}=${r.data.tagValue}` } })
        .then(setSelectedFile(null))
        .then(setFileUploadedSuccessfully(true))
        .catch((err) => console.error(err));
    })
      .catch((err) => {
        console.error(err);
      })
  }

  const onFilesList = () => {

    let Token = user.signInUserSession.idToken.jwtToken;

    const config = { headers: { Authorization: Token } };

    axios.get(listDocsEndpointURL, config).then((r) => {
      setBucketFiles(JSON.parse(r.request.response).objectLists);
      setSearchResult(null); // clear search result
    })
      .catch((err) => {
        console.error(err);
      })
  }

  const onSearch = event => {

    event.preventDefault();
    if (searchString && searchString.trim()) {

      let Token = user.signInUserSession.idToken.jwtToken;
      const config = { headers: { Authorization: Token } };

      const bodyParameters = {
        'query': searchString
      };

      axios.post(searchDocsEndpointURL, bodyParameters, config).then((r) => {
        let response = JSON.parse(r.request.response);
        let query_result = [];
        if (response.hasOwnProperty('hits')) {
          for (let hit of response.hits.hits) {
            let row = [hit._source.reviewid, hit._source.reviewBody, hit._source.department];
            query_result.push(row);
          }
        }
        setSearchCount(response.index_size);
        setSearchResult(query_result);
        setBucketFiles(null); // clear list of files
      })
        .catch((err) => {
          console.error(err);
        })
    }
  }

  const fileData = () => {
    if (selectedFile) {
      return (
        <div>
          <h3>File Details </h3>
          <p> File Name: {selectedFile.name} </p>
          <p> File Type: {selectedFile.type} </p>
        </div>);
    }
    else if (fileUploadedSuccessfully) {
      return (
        <div>
          <br />
          <h4> file uploaded successfully </h4>
        </div>);
    }
  }

  const bucketData = () => {
    if (bucketFiles) {
      return (
        <div>
          <h3>Bucket Content </h3>
          <table>
            <th>File Name</th>
            <tbody>
              {bucketFiles.map((file, index) => (
                <tr key={index}>{file}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
  }

  const searchData = () => {
    if (searchResult) {
      if (searchCount === 0) {
        return <div>No documents found. Empty index.</div>
      }
      return (
        <div>
          <h3>Multilingual Semantic Search Result</h3>
          <table>
            <caption>{`Configured to return the three nearest neighbors. Total ${searchCount} documents in the search index.`}</caption>
            <thead>
              <tr>
                <th>File Name</th>
                <th>Review Body</th>
                <th>User Department</th>
              </tr>
            </thead>
            <tbody>
              {searchResult.map((file, index) => (
                <tr key={index}>
                  <td>{file[0]}</td>
                  <td>{file[1]}</td>
                  <td>{file[2]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
  }

  return (
    <div>
      <div id="main">
        <ul>
          <li>
            <a><b>Content Repository - Demo UI</b></a>
          </li>
          <li >
            <a id="logout" onClick={signOut}>
              LOG OUT
            </a>
          </li>
        </ul>
      </div>
      <div>Upload and list documents</div>
      <div id="upload">
        <ul>
          <li>
            <input type="file" onChange={onFileChange} />
            <button className='button' onClick={onFileUpload}>
              UPLOAD
            </button>
          </li>
        </ul>
      </div>
      {fileData()}
      <div id="search">
        {bucketData()}
        <ul>
          <li>
            <label for="query">Enter text:</label>
            <input type="text" id="query" onChange={(event) => setSearchString(event.target.value)} />
            <button className='button-search' onClick={onSearch}>SEARCH</button>
            <button className='button-search' onClick={onFilesList}>
              LIST
            </button>
          </li>
          <li >

          </li>
        </ul>



      </div>
      {searchData()}
    </div >
  );
}

export default Homepage;
